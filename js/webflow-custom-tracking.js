/**
 * webflow-custom-tracking.js
 * Hosted here to provide custom tracking functionality for claude.com pages
 * published via Webflow reverse proxy.
 *
 * Contains:
 * - Universal sticky parameters (UTM tracking)
 * - Segment analytics event tracking
 * - Cross-domain link wrapping
 * - Amplitude Session Replay property injection
 *
 * Dependencies: window.analytics (loaded by privacy banner), window.sessionReplay (optional, for Session Replay)
 */

/* Canonical URI properties // Client-side replacement for the Segment
 * destination insert function "Add canonical URI properties"
 * (ifnd_6966b83ebc9b7f397f32ca07, MTECH-867). Enriches PAGE events with
 * canonical_path / canonical_url / canonical_referrer / canonical_search by
 * replacing ID-like tokens with `*`. Verbatim copy of the transform in
 * anthropics/apps `@ant/antalytics/canonicalUriProperties` (also copied in
 * frontend/src/lib/canonicalUriProperties.ts for Next.js-served pages) —
 * the rules are frozen for the dual-run parity window; improvements land in
 * the apps shared module first and are re-copied here. */

;(function () {
  'use strict'

  function canonicalizeString(str) {
    var result = str
    // Replace standard UUIDs (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
    result = result.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '*')
    // Replace 32-char hex strings (UUIDs without hyphens)
    result = result.replace(/\b[0-9a-f]{32}\b/gi, '*')
    // Replace 24-char hex strings (MongoDB ObjectIds)
    result = result.replace(/\b[0-9a-f]{24}\b/gi, '*')
    // Replace numeric IDs in URL paths (4+ digits after a slash)
    result = result.replace(/\/(\d{4,})(?=\/|$|\?|#)/g, '/*')
    return result
  }

  function canonicalizeUriValue(value) {
    if (!value || typeof value !== 'string') return value
    return canonicalizeString(value)
  }

  // URLSearchParams round-trip (set per key, then toString) is part of the
  // ported contract — dedupes repeated keys to the last occurrence and
  // re-serializes; must not be "fixed" here.
  function canonicalizeUriSearch(value) {
    if (!value || typeof value !== 'string') return value
    var params = new URLSearchParams(value.replace(/^\?/, ''))
    var canonicalParams = new URLSearchParams()
    params.forEach(function (paramValue, key) {
      canonicalParams.set(key, canonicalizeString(paramValue))
    })
    var result = canonicalParams.toString()
    return result ? '?' + result : ''
  }

  function withCanonicalUriProps(props) {
    if (!props.path && !props.url && !props.referrer && !props.search) return undefined
    var next = Object.assign({}, props)
    if (next.path) next.canonical_path = canonicalizeUriValue(next.path)
    if (next.url) next.canonical_url = canonicalizeUriValue(next.url)
    if (next.referrer) next.canonical_referrer = canonicalizeUriValue(next.referrer)
    if (next.search) next.canonical_search = canonicalizeUriSearch(next.search)
    return next
  }

  var canonicalMiddlewareRegistered = false

  function registerCanonicalMiddleware() {
    if (canonicalMiddlewareRegistered) {
      return true
    }
    if (!window.analytics || typeof window.analytics.addSourceMiddleware !== 'function') {
      return false
    }
    try {
      window.analytics.addSourceMiddleware(canonicalSourceMiddleware)
    } catch {
      // Leave the latch unset so the pre-page() retry can attempt again —
      // and never let a throw here skip the caller's page() call.
      return false
    }
    // Latch only after the call succeeded, so a failed attempt can retry.
    canonicalMiddlewareRegistered = true
    return true
  }

  function canonicalSourceMiddleware(chain) {
    var payload = chain.payload
    try {
      // Only page events — the insert function's other handlers were
      // pass-throughs.
      if (payload.obj && payload.obj.type === 'page') {
        var props = payload.obj.properties
        if (props && typeof props === 'object') {
          var next = withCanonicalUriProps(props)
          if (next) payload.obj.properties = next
        }
      }
    } catch {
      // Fail open — never block event delivery.
    }
    chain.next(payload)
  }

  // window.analytics appears only after the privacy banner loads Segment
  // (consent-gated), so it may not exist yet at parse time. Try now (the
  // snippet stubs addSourceMiddleware, so an early registration is queued
  // ahead of any queued events), and expose the idempotent register hook so
  // the cross-domain block below can call it right before its page() call —
  // the only Segment page event on these pages — making the
  // register-before-page ordering deterministic instead of a timer race.
  window.__registerCanonicalUriMiddleware = registerCanonicalMiddleware
  registerCanonicalMiddleware()
})()

/* Universal Sticky Parameters // Tracks UTM params + gclid, fbclid, and any other custom parameters */
;(function () {
  'use strict'

  // Configuration
  const CONFIG = {
    // Specify which parameters to track (leave empty to track ALL parameters)
    trackParams: [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_content',
      'utm_term', // UTM parameters
      'gclid',
      'dclid',
      'gbraid',
      'wbraid', // Google Ads parameters
      'fbclid', // Facebook parameters
      'msclkid', // Microsoft Ads parameters
      'li_fat_id', // LinkedIn parameters
      // Add your custom parameters here
      // 'custom_param1', 'custom_param2'
    ],
    // OR set to true to track ALL URL parameters
    trackAllParams: true,

    // Parameters to EXCLUDE from tracking (only used if trackAllParams is true)
    excludeParams: ['page', 'tab', 'section', 'sort', 'filter', 'search', 'id'],

    // Parameter NAME patterns to EXCLUDE from tracking (only used if trackAllParams is true).
    // Webflow CMS collection pagination uses dynamically-named params like
    // "b7eea976_page=2" — an 8-char hex instance id + "_page" — so they can't be
    // caught by the exact-match excludeParams list above. These are page-local
    // pagination state, not campaign attribution: if made sticky they get appended
    // to every link on the page, creating duplicate-content URLs and crawl traps
    // as bots propagate them across the site (major SEO problem). The length is
    // anchored to 8 to match Webflow's instance-id shape and avoid stripping
    // hypothetical all-hex campaign params (e.g. "cafe_page", "dead_page").
    excludeParamPatterns: [/^[0-9a-f]{8}_page$/i],

    storageKey: 'tracking_params',
    domainExcludePatterns: [
      /^mailto:/,
      /^tel:/,
      /^javascript:/,
      /^#/,
      /^sms:/,
      /\.pdf$/,
      /\.jpg$/,
      /\.png$/,
      /\.gif$/,
    ],
    maxObserverTime: 5000, // 5 seconds
    observerDebounceMs: 200,
    sessionLength: 30, // How long to persist parameters (in minutes)
    debug: false, // Set to true to enable console logging
  }

  // Debug logger
  const log = function (...args) {
    if (CONFIG.debug) {
      console.log('[Param Tracker]', ...args)
    }
  }

  // Utility Functions
  const utils = {
    // Debounce function to limit executions
    debounce: function (func, wait) {
      let timeout
      return function executedFunction(...args) {
        const later = () => {
          clearTimeout(timeout)
          func(...args)
        }
        clearTimeout(timeout)
        timeout = setTimeout(later, wait)
      }
    },

    // Get all tracking parameters from URL
    getTrackingParams: function () {
      const urlParams = new URLSearchParams(window.location.search)
      const params = {}

      if (CONFIG.trackAllParams) {
        // Track all parameters except excluded ones (exact names + name patterns)
        for (const [key, value] of urlParams.entries()) {
          if (CONFIG.excludeParams.includes(key.toLowerCase())) continue
          if (CONFIG.excludeParamPatterns.some((pattern) => pattern.test(key))) continue
          params[key] = value
        }
      } else {
        // Track only specified parameters
        CONFIG.trackParams.forEach((param) => {
          const value = urlParams.get(param)
          if (value) {
            params[param] = value
          }
        })
      }

      log('Extracted params:', params)
      return params
    },

    // Store parameters with expiration
    storeTrackingParams: function (params) {
      if (Object.keys(params).length > 0) {
        try {
          const data = {
            params: params,
            expiry: Date.now() + CONFIG.sessionLength * 60 * 1000,
          }
          sessionStorage.setItem(CONFIG.storageKey, JSON.stringify(data))
          log('Stored params:', data)
        } catch (e) {
          log('Storage failed:', e)
        }
      }
    },

    // Retrieve stored parameters
    getStoredTrackingParams: function () {
      try {
        const stored = sessionStorage.getItem(CONFIG.storageKey)
        if (!stored) return {}

        const data = JSON.parse(stored)

        // Check if expired
        if (Date.now() > data.expiry) {
          sessionStorage.removeItem(CONFIG.storageKey)
          log('Parameters expired')
          return {}
        }

        log('Retrieved params:', data.params)
        return data.params || {}
      } catch (e) {
        log('Retrieval failed:', e)
        return {}
      }
    },

    // Append parameters to URL
    appendParameters: function (url, params) {
      if (!url || typeof url !== 'string') return url

      try {
        // Handle relative and absolute URLs
        const urlObj = new URL(url, window.location.origin)

        // Skip external domains (unless it's a subdomain)
        const currentHost = window.location.hostname
        const urlHost = urlObj.hostname
        if (
          urlHost !== currentHost &&
          !urlHost.endsWith('.' + currentHost.split('.').slice(-2).join('.'))
        ) {
          return url
        }

        // Add parameters
        Object.keys(params).forEach((key) => {
          if (!urlObj.searchParams.has(key)) {
            urlObj.searchParams.set(key, params[key])
          }
        })

        return urlObj.toString()
      } catch {
        // Fallback for malformed URLs
        if (url.indexOf('?') === -1) {
          const paramString = Object.keys(params)
            .map((key) => `${key}=${encodeURIComponent(params[key])}`)
            .join('&')
          return `${url}?${paramString}`
        }
        return url
      }
    },

    // Check if URL should be excluded
    shouldExcludeURL: function (url) {
      return CONFIG.domainExcludePatterns.some((pattern) => pattern.test(url))
    },
  }

  // Link update function
  function updateLinks() {
    const storedParams = utils.getStoredTrackingParams()

    if (Object.keys(storedParams).length === 0) return

    // Use querySelectorAll for better performance
    const links = document.querySelectorAll('a[href]')

    links.forEach((link) => {
      const href = link.getAttribute('href')

      // Skip if URL should be excluded
      if (!href || utils.shouldExcludeURL(href)) return

      // Check if it's an internal link
      const newHref = utils.appendParameters(href, storedParams)
      if (newHref !== href) {
        link.setAttribute('href', newHref)
        log('Updated link:', href, '→', newHref)
      }
    })
  }

  // Optimized mutation observer
  let observer
  function setupObserver() {
    // Debounced update function
    const debouncedUpdate = utils.debounce(updateLinks, CONFIG.observerDebounceMs)

    observer = new MutationObserver((mutations) => {
      // Check if any mutation contains new links
      const hasNewLinks = mutations.some((mutation) => {
        return Array.from(mutation.addedNodes).some(
          (node) => node.nodeType === 1 && (node.tagName === 'A' || node.querySelector('a')),
        )
      })

      if (hasNewLinks) {
        debouncedUpdate()
      }
    })

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    })

    // Disconnect observer after timeout to prevent memory leaks
    setTimeout(() => {
      if (observer) {
        observer.disconnect()
        observer = null
        log('Observer disconnected')
      }
    }, CONFIG.maxObserverTime)
  }

  // Initialize function
  function init() {
    log('Initializing...')

    // Get tracking parameters from current URL
    const currentParams = utils.getTrackingParams()

    // Store new parameters if present
    if (Object.keys(currentParams).length > 0) {
      utils.storeTrackingParams(currentParams)
    }

    // Initial link update
    updateLinks()

    // Setup mutation observer
    setupObserver()
  }

  // Event listeners
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }

  // Handle browser navigation
  window.addEventListener('popstate', init)

  // Clean up on page unload (optional)
  window.addEventListener('beforeunload', () => {
    if (observer) {
      observer.disconnect()
    }
  })

  // Expose API for external use (optional)
  window.paramTracker = {
    getStoredParams: utils.getStoredTrackingParams,
    refreshLinks: updateLinks,
    addCustomParams: function (customParams) {
      const currentParams = utils.getStoredTrackingParams()
      const mergedParams = Object.assign({}, currentParams, customParams)
      utils.storeTrackingParams(mergedParams)
      updateLinks()
    },
    clearParams: function () {
      sessionStorage.removeItem(CONFIG.storageKey)
      log('Parameters cleared')
    },
  }
})()

/* Segment tracking */

document.addEventListener('DOMContentLoaded', function () {
  function initSegmentTracking() {
    // Wait for Segment to be ready
    window.analytics.ready(function () {
      // Add source middleware to attach Amplitude Session Replay properties to all events
      // This ensures every track/page/identify call includes the Session Replay ID
      // Reference: https://amplitude.com/docs/session-replay/session-replay-integration-with-segment
      if (typeof window.analytics.addSourceMiddleware === 'function') {
        window.analytics.addSourceMiddleware(function (chain) {
          var payload = chain.payload

          // Only add session replay properties if Session Replay is initialized
          if (
            window.amplitudeSessionReplayInitialized &&
            typeof window.sessionReplay !== 'undefined'
          ) {
            try {
              // Get session replay properties (includes [Amplitude] Session Replay ID)
              var sessionReplayProps = window.sessionReplay.getSessionReplayProperties()

              if (sessionReplayProps && Object.keys(sessionReplayProps).length > 0) {
                // Merge session replay properties into the event properties
                if (payload.obj && payload.obj.properties) {
                  payload.obj.properties = Object.assign(
                    {},
                    payload.obj.properties,
                    sessionReplayProps,
                  )
                } else if (payload.obj) {
                  payload.obj.properties = sessionReplayProps
                }

                // Also add to integrations for Amplitude destination
                if (!payload.obj.integrations) {
                  payload.obj.integrations = {}
                }
                if (!payload.obj.integrations.Amplitude) {
                  payload.obj.integrations.Amplitude = {}
                }
                // Pass session_id to Amplitude integration
                var sessionIdCookie = document.cookie.split(';').find(function (c) {
                  return c.trim().startsWith('analytics_session_id=')
                })
                if (sessionIdCookie) {
                  payload.obj.integrations.Amplitude.session_id = parseInt(
                    sessionIdCookie.split('=')[1],
                    10,
                  )
                }
              }
            } catch {
              // Silent fail - don't break event tracking if session replay has issues
            }
          }

          chain.next(payload)
        })
      }

      // Send custom Page Viewed event
      window.analytics.track('anthropicdotcom.page.viewed', {
        page_title: document.title,
        page_url: window.location.href,
        page_path: window.location.pathname,
        referrer: document.referrer || 'direct',
        prefers_color_scheme: window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light',
      })

      // Track clicks on elements with data-cta attribute
      document.addEventListener('click', function (event) {
        const element = event.target
        const ctaElement = element.closest('[data-cta]')
        if (ctaElement) {
          const ctaData = {
            cta: ctaElement.getAttribute('data-cta'),
            cta_copy: ctaElement.getAttribute('data-cta-copy'),
            cta_position: ctaElement.getAttribute('data-cta-position'),
          }
          Object.keys(ctaData).forEach((key) => {
            if (ctaData[key] === null || ctaData[key] === undefined) {
              delete ctaData[key]
            }
          })
          window.analytics.track('anthropicdotcom.cta.clicked', ctaData)
        }
      })

      // Track Iterable newsletter form submissions
      document.querySelectorAll('[data-form="iterable"]').forEach((form, index) => {
        // Ensure form wrapper exists
        const formWrapper = form.closest('.w-form')
        if (!formWrapper) return

        // Flag to prevent duplicate tracking
        let isTracking = false

        form.addEventListener('submit', function () {
          if (isTracking) return
          isTracking = true

          // Capture form data at submission time
          const emailField = form.querySelector('input[type="email"]')
          const emailValue = emailField ? emailField.value.toLowerCase().trim() : ''

          // Build consistent event properties
          const baseProperties = {
            email: emailValue,
            form_name: form.getAttribute('data-name') || 'newsletter',
            form_id: form.getAttribute('id') || `newsletter-form-${index}`,
            page_path: window.location.pathname,
            page_url: window.location.href,
            page_title: document.title,
            referrer: document.referrer || 'direct',
            timestamp: new Date().toISOString(),
          }

          // Monitor for Webflow's response
          let attempts = 0
          const maxAttempts = 30 // 15 seconds maximum

          const checkFormState = setInterval(() => {
            attempts++

            // Check for success state
            const successBlock = formWrapper.querySelector('.w-form-done')
            const errorBlock = formWrapper.querySelector('.w-form-fail')
            const successVisible =
              successBlock && window.getComputedStyle(successBlock).display === 'block'
            const errorVisible =
              errorBlock && window.getComputedStyle(errorBlock).display === 'block'

            if (successVisible) {
              // Track successful subscription
              window.analytics.track('anthropicdotcom.newsletter.subscribed', baseProperties)
              clearInterval(checkFormState)
              isTracking = false

              // Optional: Clear form after success
              form.reset()
            } else if (errorVisible) {
              // Track error
              const errorText = errorBlock.textContent?.trim() || 'Unknown error'
              window.analytics.track('anthropicdotcom.newsletter.error', {
                ...baseProperties,
                error_message: errorText,
                error_type: errorText.toLowerCase().includes('already')
                  ? 'duplicate_email'
                  : 'submission_error',
              })
              clearInterval(checkFormState)
              isTracking = false
            } else if (attempts >= maxAttempts) {
              // Timeout - track as error
              window.analytics.track('anthropicdotcom.newsletter.error', {
                ...baseProperties,
                error_message: 'Form submission timeout',
                error_type: 'timeout',
              })
              clearInterval(checkFormState)
              isTracking = false
            }
          }, 500)
        })
      })

      // Track HubSpot form submissions.
      //
      // HubSpot's forms embed (v2) posts hsFormCallback messages to the host
      // window on form lifecycle events; onFormSubmitted fires only after
      // HubSpot ACCEPTS the submission (unlike onFormSubmit, which fires on
      // the submit click before the POST resolves). Listening at the window
      // covers any HubSpot form on the page without touching its embed code —
      // and on pages with no HubSpot form the listener never matches, so it
      // is inert everywhere else.
      //
      // Mirrors the claudecom.hubspot_form.submitted event fired by the
      // Next.js HubSpotForm organism (same name + properties), so one event
      // covers every claude.com HubSpot form regardless of which stack serves
      // the page. No form field values are sent — form_id is the only custom
      // property, and it is what distinguishes forms downstream.
      //
      // (anthropic.com Webflow pages load their own fork of this file from
      // the anthropics/website repo, not this one — no per-domain handling
      // needed here.)
      window.addEventListener('message', function (event) {
        // The inline v2 embed's script runs in the page itself, so its
        // messages arrive from THIS window with the page's own origin
        // (verified against the live embed — NOT from an *.hsforms.net
        // iframe). Reject everything else so cross-origin frames and
        // extension content can't spoof submissions.
        if (event.source !== window || event.origin !== window.location.origin) {
          return
        }

        const data = event.data
        if (!data || data.type !== 'hsFormCallback' || data.eventName !== 'onFormSubmitted') {
          return
        }

        window.analytics.track('claudecom.hubspot_form.submitted', {
          form_id: data.id,
          page_path: window.location.pathname,
          page_url: window.location.href,
          page_title: document.title,
        })
      })

      // Track app download button clicks
      // Usage: Add data-app-download="platform" to download buttons (e.g., data-app-download="ios")
      document.addEventListener('click', function (event) {
        const downloadButton = event.target.closest('[data-app-download]')

        if (downloadButton) {
          // Get the platform from the button's data attribute value
          const buttonPlatform = downloadButton.getAttribute('data-app-download')

          // Detect user's platform
          const userAgent = navigator.userAgent.toLowerCase()
          let userPlatform = 'other'

          if (
            userAgent.includes('iphone') ||
            userAgent.includes('ipad') ||
            (userAgent.includes('mac') && 'ontouchend' in document)
          ) {
            userPlatform = 'ios'
          } else if (userAgent.includes('macintosh')) {
            userPlatform = 'mac'
          } else if (userAgent.includes('android')) {
            userPlatform = 'android'
          } else if (
            userAgent.includes('windows') ||
            userAgent.includes('win32') ||
            userAgent.includes('win64')
          ) {
            if (
              userAgent.includes('arm') ||
              userAgent.includes('aarch64') ||
              userAgent.includes('arm64')
            ) {
              userPlatform = 'win-arm64'
            } else {
              userPlatform = 'win-x64'
            }
          }

          // Track the event
          window.analytics.track('apps.download_button_clicked', {
            platform: buttonPlatform,
            userPlatform: userPlatform,
            source: 'download_page',
          })
        }
      })

      // Track scroll depth milestones (25/50/75/100% of the page).
      //
      // Mirrors the claudecom.scroll.depth_reached event fired by the
      // Next.js ScrollDepthTracking molecule (same name + properties), so
      // one event covers every claude.com page regardless of which stack
      // serves it. Runs inside analytics.ready() so nothing fires before
      // consent resolves; the initial check below captures the visitor's
      // current depth at that point (and pages shorter than the viewport,
      // which report only 100 — all content was on screen).
      const scrollMilestones = [25, 50, 75, 100]
      const firedScrollMilestones = {}

      function trackScrollDepth(depth) {
        window.analytics.track('claudecom.scroll.depth_reached', {
          depth: depth,
          page_path: window.location.pathname,
          page_url: window.location.href,
          page_title: document.title,
        })
      }

      function checkScrollDepth() {
        const doc = document.documentElement

        // "100% of the page" means the viewport has reached the TOP of the
        // page footer, not the last pixel of the document — the footer (nav
        // columns, legal links) is chrome, and counting it keeps genuine
        // full reads from ever registering 100. The LAST <footer> in
        // document order is the page footer (in-article <footer>s come
        // earlier); Webflow builds it as <footer class="footer_wrap">.
        // Pages without a visible footer fall back to the full document
        // height.
        const footers = document.getElementsByTagName('footer')
        const footerRect =
          footers.length > 0 ? footers[footers.length - 1].getBoundingClientRect() : undefined
        // A zero-height rect means the footer is hidden — ignore it.
        const footerTop = footerRect && footerRect.height > 0 ? doc.scrollTop + footerRect.top : NaN
        const contentEnd = footerTop > 0 ? Math.min(footerTop, doc.scrollHeight) : doc.scrollHeight

        const scrollableHeight = contentEnd - doc.clientHeight

        if (scrollableHeight <= 0) {
          // Not scrollable (or all content above the footer fits on screen).
          if (!firedScrollMilestones[100]) {
            firedScrollMilestones[100] = true
            trackScrollDepth(100)
          }
          return
        }

        // Float tolerance (same as the Next.js ScrollDepthTracking molecule):
        // zoom and fractional device pixels routinely report scrollTop a
        // fraction of a pixel short of the max at the physical bottom, which
        // would keep the 100 milestone from ever firing on HiDPI viewports.
        const scrollPercentage = (doc.scrollTop / scrollableHeight) * 100 + 0.5
        scrollMilestones.forEach((milestone) => {
          if (scrollPercentage >= milestone && !firedScrollMilestones[milestone]) {
            firedScrollMilestones[milestone] = true
            trackScrollDepth(milestone)
          }
        })
      }

      // Throttle scroll checks to one per frame
      let scrollDepthTicking = false
      window.addEventListener(
        'scroll',
        function () {
          if (scrollDepthTicking) return
          scrollDepthTicking = true
          requestAnimationFrame(function () {
            checkScrollDepth()
            scrollDepthTicking = false
          })
        },
        {passive: true},
      )

      // Initial check for depth already reached before analytics was ready
      checkScrollDepth()
    })
  }

  // Wait for analytics to be available (may not be loaded yet due to async privacy banner)
  // This handles the race condition where custom-tracking runs before privacy-banner
  // has finished loading Segment analytics
  if (window.analytics && typeof window.analytics.ready === 'function') {
    initSegmentTracking()
  } else {
    // Retry until analytics is available or timeout after 10 seconds
    let attempts = 0
    const maxAttempts = 20
    const checkInterval = setInterval(function () {
      attempts++
      if (window.analytics && typeof window.analytics.ready === 'function') {
        clearInterval(checkInterval)
        initSegmentTracking()
      } else if (attempts >= maxAttempts) {
        // Analytics never loaded (user likely declined consent)
        clearInterval(checkInterval)
      }
    }, 500)
  }
})

/* Blog Time on Page Tracking
 *
 * Intentionally placed outside the DOMContentLoaded/initSegmentTracking block:
 * - The timer is pure arithmetic (no DOM interaction), so it can start immediately
 *   for more accurate time measurement vs. waiting for DOMContentLoaded + analytics.ready()
 * - Events only fire via track() which guards on window.analytics availability, so if the
 *   user declines consent and Segment never loads, events silently no-op
 * - The first milestone (10s) fires well after the privacy banner resolves, so analytics
 *   is available by the time we need it
 * - The Session Replay middleware registered in initSegmentTracking applies globally to all
 *   analytics.track() calls, so replay IDs are attached to these events automatically
 */
;(function () {
  'use strict'

  // Only run on individual blog post pages (not index or non-blog pages)
  if (!/^\/blog\/.+/.test(window.location.pathname)) return

  const milestones = [10, 30, 60, 120, 300] // seconds
  const firedMilestones = {}
  let firedCount = 0
  let activeTime = 0
  let lastTick = null
  let tickInterval = null

  function track(seconds) {
    if (!window.analytics || typeof window.analytics.track !== 'function') return
    window.analytics.track('blog.time_on_page.milestone', {
      pathname: window.location.pathname,
      seconds: seconds,
      page_title: document.title,
      page_url: window.location.href,
      referrer: document.referrer || 'direct',
    })
  }

  function checkMilestones() {
    for (let i = 0; i < milestones.length; i++) {
      const ms = milestones[i]
      if (activeTime >= ms && !firedMilestones[ms]) {
        firedMilestones[ms] = true
        firedCount++
        track(ms)
      }
    }
    if (firedCount === milestones.length) cleanup()
  }

  function tick() {
    if (document.visibilityState !== 'visible') return

    const now = Date.now()
    if (lastTick) {
      activeTime += (now - lastTick) / 1000
    }
    lastTick = now

    checkMilestones()
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'visible') {
      lastTick = Date.now()
    } else {
      // Flush remaining active time before pausing
      if (lastTick) {
        const now = Date.now()
        activeTime += (now - lastTick) / 1000
        checkMilestones()
      }
      lastTick = null
    }
  }

  function cleanup() {
    clearInterval(tickInterval)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', cleanup)
  }

  // Start tracking (only set lastTick if tab is visible to handle background-tab opens)
  lastTick = document.visibilityState === 'visible' ? Date.now() : null
  tickInterval = setInterval(tick, 1000)
  document.addEventListener('visibilitychange', onVisibilityChange)

  // Cleanup on navigation (pagehide alone is sufficient and bfcache-friendly;
  // beforeunload would prevent bfcache eligibility in some browsers)
  window.addEventListener('pagehide', cleanup)
})()

/* Cross-Domain Link Script */

/* It automatically wraps claude.ai links with anonymous IDs for tracking. This is a no-op if Segment analytics is not initialized */
;(function () {
  let observer
  const sourceAttribution = 'claudedotcom.v1'
  const validPrefixes = ['claudedotcom.v1', 'claudeai.v1'] // Recognize both prefixes

  function wrapLinks(container = document) {
    if (!window.analytics?.user) return

    let anonymousId = window.analytics.user().anonymousId()
    if (!anonymousId) return

    // Check if the anonymous ID already has a valid prefix
    const hasValidPrefix = validPrefixes.some((prefix) => anonymousId.startsWith(prefix + '.'))

    if (!hasValidPrefix) {
      const fullId = `${sourceAttribution}.${anonymousId}`
      try {
        window.analytics.user().anonymousId(fullId)
        anonymousId = fullId
      } catch {
        // Silent fail, use original ID
      }
    }

    container.querySelectorAll('a[href*="claude.ai"]:not([href*="/redirect/"])').forEach((link) => {
      try {
        const url = new URL(link.href)
        if (url.hostname === 'claude.ai' || url.hostname === 'www.claude.ai') {
          const originalPath = url.pathname === '/' ? '' : url.pathname
          url.pathname = `/redirect/${anonymousId}${originalPath}`
          link.href = url.toString()
        }
      } catch {
        // Silent fail, leave link unchanged
      }
    })
  }

  function startObserver() {
    if (!window.analytics?.user) return

    if (observer) observer.disconnect()

    observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.tagName === 'A' && node.href && node.href.includes('claude.ai')) {
              wrapLinks(node.parentElement)
            } else if (node.querySelector) {
              const claudeLinks = node.querySelectorAll('a[href*="claude.ai"]')
              if (claudeLinks.length > 0) {
                wrapLinks(node)
              }
            }
          }
        })
      })
    })

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    })
  }

  function initialize() {
    wrapLinks()
    startObserver()
    // Send page call here instead of init in case anon id was updated
    if (window.analytics?.page) {
      // Canonical URI middleware (defined earlier in this file) must be
      // registered before the page event is sent (MTECH-867).
      if (typeof window.__registerCanonicalUriMiddleware === 'function') {
        window.__registerCanonicalUriMiddleware()
      }
      window.analytics.page()
    }
  }

  function waitForAnalytics(attempt = 1) {
    if (window.analytics && window.analytics.user) {
      initialize()
    } else if (window.analytics && window.analytics.ready && attempt === 1) {
      const readyTimeout = setTimeout(() => {
        waitForAnalytics(2)
      }, 3000)

      window.analytics.ready(() => {
        clearTimeout(readyTimeout)
        initialize()
      })
    } else {
      if (attempt > 20) return
      setTimeout(() => waitForAnalytics(attempt + 1), 500)
    }
  }

  if (window.analytics) {
    waitForAnalytics()
  } else {
    window.addEventListener('load', () => {
      setTimeout(waitForAnalytics, 1000)
    })
  }

  window.addEventListener('beforeunload', () => {
    if (observer) observer.disconnect()
  })
})()
