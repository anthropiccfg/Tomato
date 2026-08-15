/**
 * webflow-privacy-banner.js
 * Hosted here to provide GDPR-compliant privacy consent management for
 * claude.com pages published via Webflow reverse proxy.
 *
 * Contains:
 * - Cookie consent banner UI and logic
 * - Country detection for GDPR compliance
 * - Conditional Segment Analytics loading
 * - GTM consent mode integration
 * - Webflow Optimize consent handling
 * - Amplitude Session Replay initialization
 *
 * Dependencies: External consent banner HTML, Amplitude Session Replay SDK (loaded via CDN)
 */

/* Privacy Choices Consent Banner */

;(function () {
  'use strict'

  const antalyticsLoader = document.createElement('script') // nosemgrep: create-script-element
  antalyticsLoader.async = true
  antalyticsLoader.src = 'https://claude.com/shared/webflow-antalytics.js'
  document.head.appendChild(antalyticsLoader)

  // Constants
  const CONSENT_PREFERENCES_COOKIE_KEY = 'anthropic-consent-preferences'

  /**
   * Countries and regions that require explicit user consent before setting
   * non-essential cookies (analytics, marketing, etc.) under privacy regulations.
   *
   * This list includes:
   * - EU 27 member states (GDPR)
   * - EU member state overseas territories
   * - United Kingdom and territories (UK GDPR)
   * - Canada (PIPEDA)
   * - Brazil (LGPD)
   * - India (DPDPA)
   *
   * Keep this in sync with website repo and apps repo.
   */
  const EXPLICIT_CONSENT_COUNTRIES = new Set([
    // EU 27 Member States (GDPR)
    'AT',
    'BE',
    'BG',
    'HR',
    'CY',
    'CZ',
    'DK',
    'EE',
    'FI',
    'FR',
    'DE',
    'GR',
    'HU',
    'IE',
    'IT',
    'LV',
    'LT',
    'LU',
    'MT',
    'NL',
    'PL',
    'PT',
    'RO',
    'SK',
    'SI',
    'ES',
    'SE',
    // French overseas territories
    'RE',
    'GP',
    'MQ',
    'GF',
    'YT',
    'BL',
    'MF',
    'PM',
    'WF',
    'PF',
    'NC',
    // Dutch overseas territories
    'AW',
    'CW',
    'SX',
    // Danish territories
    'FO',
    'GL',
    // Finnish territory
    'AX',
    // United Kingdom (UK GDPR)
    'GB',
    'UK',
    // UK overseas territories and Crown Dependencies
    'AI',
    'BM',
    'IO',
    'VG',
    'KY',
    'FK',
    'GI',
    'MS',
    'PN',
    'SH',
    'TC',
    'GG',
    'JE',
    'IM',
    // Other regions with privacy regulations
    'CA', // Canada (PIPEDA)
    'BR', // Brazil (LGPD)
    'IN', // India (DPDPA)
  ])

  /**
   * Configuration for cookies to delete when users opt out of tracking.
   * Based on: https://privacy.claude.com/en/articles/10023541-what-cookies-does-anthropic-use
   */
  const COOKIES_PER_CONSENT_CATEGORY = {
    analytics: [
      // Segment
      'ajs_anonymous_id',
      'ajs_user_id',
      'ajs_group_id',
      'analytics_session_id',
      // Google Analytics (first-party)
      '_ga',
      '_gid',
      '_gat',
      // Legacy Google Analytics
      '__utma',
      '__utmb',
      '__utmc',
      '__utmt',
      '__utmz',
      '__utmv',
      // Google Optimize
      '_gaexp',
      '_gaexp_rc',
      '_opt_expid',
      // Other GA first-party cookies
      'AMP_TOKEN',
      'FPID',
      'FPLC',
      'TESTCOOKIESENABLED',
      // LinkedIn
      'li_giant',
      'ln_or',
      // Oribi
      'oribi_cookie_test',
      'oribili_user_guid',
    ],
    marketing: [
      // Facebook (first-party)
      '_fbc',
      '_fbp',
      // Google Ads & Conversion Tracking (first-party)
      '__gads',
      '__gpi',
      '__gpi_optout',
      '__gsas',
      '_gcl_aw',
      '_gcl_dc',
      '_gcl_au',
      '_gcl_gb',
      '_gcl_gf',
      '_gcl_ha',
      '_gcl_gs',
      '_gcl_ag',
      'GCL_AW_P',
      'GED_PLAYLIST_ACTIVITY',
      'ACLK_DATA',
      'FLC',
      // Google Ads first-party cookies
      '_opt_awcid',
      '_opt_awmid',
      '_opt_awgid',
      '_opt_awkid',
      '_opt_utmc',
      'FPAU',
      'FPGCLDC',
      'FPGCLAW',
      'FPGCLGB',
      'FPGSID',
      'FCCDCF',
      'FCNEC',
      // LinkedIn (first-party)
      'li_fat_id',
      'ar_debug',
      // TikTok (first-party)
      '_ttclid',
      // Reddit (first-party)
      '_rdt_uuid',
      '_rdt_cid',
    ],
  }

  /**
   * Cookie name patterns that should be deleted (regex-based matching).
   */
  const COOKIE_PATTERNS_TO_DELETE = {
    analytics: [/^_gat_gtag_UA_.*$/, /^_ga_.*$/, /^_dc_gtm_.*$/],
    marketing: [/^_gac_.*$/, /^_gac_gb_.*$/],
  }

  /**
   * Gets the appropriate domain for cookies based on hostname.
   * Returns a domain string starting with '.' for cross-subdomain cookies,
   * or undefined for unknown/local domains (which scopes cookie to current host only).
   */
  function getDomainFromHost(hostname) {
    if (hostname === 'claude.com' || hostname.endsWith('.claude.com')) {
      return '.claude.com'
    }
    // For all other domains (including localhost, staging, etc.), return undefined
    // This scopes cookies to the current host only
    return undefined
  }

  // Cookie utilities
  const cookieUtils = {
    get(name) {
      const cookies = document.cookie.split(';')
      for (let i = 0; i < cookies.length; i++) {
        const cookie = cookies[i].trim()
        const [key, value] = cookie.split('=')
        if (name === key) {
          return decodeURIComponent(value)
        }
      }
      return undefined
    },

    set(name, value) {
      const hostname = window.location.hostname
      const domain = getDomainFromHost(hostname)
      const path = '/'

      const cookieParts = [
        `${name}=${encodeURIComponent(value)}`,
        `max-age=${60 * 60 * 24 * 365}`, // 1 year in seconds
        `path=${path}`,
        'samesite=lax',
        'secure',
      ]

      if (domain) {
        cookieParts.push(`domain=${domain}`)
      }

      document.cookie = cookieParts.join('; ')
    },

    has(name) {
      return document.cookie.split(';').some((cookie) => cookie.trim().startsWith(`${name}=`))
    },

    delete(name) {
      const hostname = window.location.hostname
      const domain = getDomainFromHost(hostname)
      const path = '/'

      // Delete cookie by setting it with an expired date
      const cookieParts = [`${name}=`, 'expires=Thu, 01 Jan 1970 00:00:00 GMT', `path=${path}`]

      if (domain) {
        cookieParts.push(`domain=${domain}`)
      }

      document.cookie = cookieParts.join('; ')
    },
  }

  /**
   * Helper function to get all cookie names from document.cookie
   */
  function getAllCookieNames() {
    return document.cookie.split(';').map((cookie) => cookie.split('=')[0].trim())
  }

  /**
   * Helper function to check if a cookie name matches a pattern
   * Supports both exact string matches and RegExp patterns
   */
  function matchesCookiePattern(cookieName, pattern) {
    if (pattern instanceof RegExp) {
      return pattern.test(cookieName)
    }
    return cookieName === pattern
  }

  /**
   * Deletes cookies for a specific consent category when user opts out.
   * Automatically determines the appropriate domain from the current hostname.
   */
  function deleteCookiesForCategory(category) {
    const allCookieNames = getAllCookieNames()

    // Delete named cookies
    COOKIES_PER_CONSENT_CATEGORY[category].forEach((cookieName) => {
      cookieUtils.delete(cookieName)
    })

    // Delete pattern-based cookies (regex)
    const patterns = COOKIE_PATTERNS_TO_DELETE[category] || []
    patterns.forEach((pattern) => {
      allCookieNames.forEach((cookieName) => {
        if (matchesCookiePattern(cookieName, pattern)) {
          cookieUtils.delete(cookieName)
        }
      })
    })
  }

  /**
   * Checks if user is in a country requiring explicit consent.
   * Uses server-side API first, then falls back to browser language detection.
   */
  async function inExplicitConsentRequiredCountry() {
    try {
      // Try server-side country detection first
      const response = await fetch('https://www.anthropic.com/api/country')
      const data = await response.json()

      if (data.country && typeof data.country === 'string') {
        return EXPLICIT_CONSENT_COUNTRIES.has(data.country)
      }

      // Fallback to browser language detection
      return fallbackLanguageDetection()
    } catch (e) {
      // Fallback to browser language detection on error
      return fallbackLanguageDetection()
    }
  }

  /**
   * Fallback method using browser language to detect country.
   */
  function fallbackLanguageDetection() {
    try {
      const browserLanguage = navigator.languages?.[0] || navigator.language
      const browserLocale = browserLanguage.split('-')[1]
      return EXPLICIT_CONSENT_COUNTRIES.has(browserLocale)
    } catch (e) {
      return false
    }
  }

  /**
   * Checks if Global Privacy Control (GPC) is enabled.
   * GPC is a browser signal that indicates the user doesn't want their data sold or shared.
   * Reference: https://globalprivacycontrol.org/
   */
  function isGlobalPrivacyControlEnabled() {
    return navigator.globalPrivacyControl === true
  }

  /**
   * Gets initial consent preferences from cookie or defaults based on country and GPC.
   */
  async function getInitialConsentPreferences() {
    // GPC takes precedence - if enabled, deny all tracking regardless of other settings
    if (isGlobalPrivacyControlEnabled()) {
      // Delete any existing tracking cookies when GPC is enabled
      // This ensures cookies from previous sessions are removed when user enables GPC
      deleteCookiesForCategory('analytics')
      deleteCookiesForCategory('marketing')
      return {analytics: false, marketing: false}
    }

    const consentPreferencesCookie = cookieUtils.get(CONSENT_PREFERENCES_COOKIE_KEY)
    if (consentPreferencesCookie) {
      try {
        return JSON.parse(consentPreferencesCookie)
      } catch {
        // Fall through to default logic
      }
    }

    // If no cookie exists, determine defaults based on country
    const requiresExplicitConsent = await inExplicitConsentRequiredCountry()
    return {
      analytics: !requiresExplicitConsent,
      marketing: !requiresExplicitConsent,
    }
  }

  /**
   * Updates Google Tag Manager consent preferences.
   * Note: GTM is only loaded when marketing consent is granted, so this function
   * primarily handles consent updates for users who change preferences mid-session.
   * If GTM isn't loaded yet but marketing consent is now granted, it will load on
   * the next page navigation when the consent cookie is read.
   */
  function updateGTMConsentPreferences(preferences) {
    if (typeof window.gtag !== 'function') return

    window.gtag('consent', 'update', {
      ad_personalization: preferences.marketing ? 'granted' : 'denied',
      ad_user_data: preferences.marketing ? 'granted' : 'denied',
      ad_storage: preferences.marketing ? 'granted' : 'denied',
      analytics_storage: preferences.analytics ? 'granted' : 'denied',
      functionality_storage: 'granted',
      personalization_storage: 'granted',
      security_storage: 'granted',
    })
  }

  /**
   * Updates Webflow Optimize tracking based on analytics consent.
   * Webflow Optimize respects analytics consent since A/B testing is analytics-related.
   */
  function updateWebflowOptimizeConsent(preferences) {
    if (typeof window.wf === 'undefined') return

    // Wrap in wf.ready() to ensure tracking methods are available
    if (typeof window.wf.ready === 'function') {
      window.wf.ready(() => {
        // Allow tracking if analytics is consented, deny otherwise
        if (preferences.analytics) {
          window.wf.allowUserTracking()
        } else {
          window.wf.denyUserTracking()
        }
      })
    }
  }

  /**
   * Saves consent preferences and handles cookie deletion for rejected categories.
   * Scripts will load/unload on next page navigation based on saved consent.
   */
  function saveConsentPreferences(preferences) {
    // Save preferences cookie
    cookieUtils.set(CONSENT_PREFERENCES_COOKIE_KEY, JSON.stringify(preferences))

    // Keep the published verdict and the antalytics loader in sync
    window.__anthropicEffectiveConsent = {...preferences}
    window.dispatchEvent(new CustomEvent('anthropic-consent-updated'))

    // Delete cookies for rejected categories
    Object.keys(preferences).forEach((category) => {
      if (!preferences[category] && COOKIES_PER_CONSENT_CATEGORY[category]) {
        deleteCookiesForCategory(category)
      }
    })

    // Update GTM consent state
    updateGTMConsentPreferences(preferences)

    // Update Webflow Optimize consent state
    updateWebflowOptimizeConsent(preferences)

    // Hide banner
    hideBanner()
  }

  // UI Functions
  function showBanner() {
    const dialog = document.getElementById('consent-container')
    if (!dialog) return

    dialog.show()
    requestAnimationFrame(() => {
      dialog.classList.add('show')
    })

    document.getElementById('simple-options').style.display = 'grid'
    document.getElementById('detailed-options').style.display = 'none'
    document.getElementById('consent-description').innerHTML =
      'We use cookies to deliver and improve our services, analyze site usage, and if you agree, to customize or personalize your experience and market our services to you. You can read our Cookie Policy <a href="https://www.anthropic.com/legal/cookies" style="color: #a1a0a0; text-decoration: underline;">here</a>.'
  }

  function hideBanner() {
    const dialog = document.getElementById('consent-container')
    if (!dialog) return

    dialog.classList.remove('show')
    setTimeout(() => dialog.close(), 300)
  }

  function showDetailedOptions() {
    document.getElementById('simple-options').style.display = 'none'
    document.getElementById('detailed-options').style.display = 'block'
    document.getElementById('consent-description').innerHTML =
      'Our website uses cookies to distinguish you from other users of our website. This helps us provide you with a more personalized experience when you browse our website and also allows us to improve our site. Cookies may collect information that is used to tailor ads shown to you on our website and other websites. The information might be about you, your preferences or your device. The information does not usually directly identify you, but it can give you a more personalized web experience. You can choose not to allow some types of cookies.'

    // Use async function to get preferences
    getInitialConsentPreferences().then((currentPreferences) => {
      if (currentPreferences) {
        updateToggleStatus('analytics-consent', 'analytics-status', currentPreferences.analytics)
        updateToggleStatus('marketing-consent', 'marketing-status', currentPreferences.marketing)
      }
    })
  }

  function updateToggleStatus(elementId, statusElementId, checked) {
    const element = document.getElementById(elementId)
    const statusElement = document.getElementById(statusElementId)
    if (element) element.checked = checked
    if (statusElement) statusElement.textContent = checked ? 'On' : 'Off'
  }

  // Initialize on DOMContentLoaded
  document.addEventListener('DOMContentLoaded', async function () {
    // Get initial preferences
    const initialPreferences = await getInitialConsentPreferences()

    // Publish the effective verdict (cookie OR regional default) for the
    // antalytics loader: implied consent in opt-out regions never writes a
    // cookie, so a cookie-only reader drops the traffic Segment keeps.
    window.__anthropicEffectiveConsent = {...initialPreferences}
    window.dispatchEvent(new CustomEvent('anthropic-consent-updated'))

    // Set up dataLayer and gtag function
    // NOTE: This must be initialized before any gtag() calls, regardless of consent preferences.
    // The dataLayer array and gtag function are infrastructure that Google Consent Mode requires.
    window.dataLayer = window.dataLayer || []
    function gtag() {
      window.dataLayer.push(arguments)
    }
    window.gtag = gtag

    // Set Google Consent Mode defaults based on user preferences
    // This is called regardless of whether GTM loads, as other Google tags may use these signals.
    // Each consent type is set based on the corresponding user preference.
    gtag('consent', 'default', {
      ad_personalization: initialPreferences.marketing ? 'granted' : 'denied',
      ad_user_data: initialPreferences.marketing ? 'granted' : 'denied',
      ad_storage: initialPreferences.marketing ? 'granted' : 'denied',
      analytics_storage: initialPreferences.analytics ? 'granted' : 'denied',
      functionality_storage: 'granted',
      personalization_storage: initialPreferences.marketing ? 'granted' : 'denied',
      security_storage: 'granted',
    })

    // Conditionally load Google Tag Manager based on marketing consent
    // GDPR COMPLIANCE NOTE: Per German Administrative Court of Hanover ruling (March 2025),
    // GTM transmits user data (IP, device info) to Google servers immediately on load.
    // This constitutes personal data processing under GDPR and requires prior consent.
    // GTM is only loaded after explicit user consent to comply with EU privacy regulations.
    // Reference: https://www.didomi.io/blog/google-tag-manager-gtm-consent-2025-germany
    if (initialPreferences.marketing) {
      // Load GTM (claude.com container: GTM-NRG742MW)
      ;(function (w, d, s, l, i) {
        w[l] = w[l] || []
        w[l].push({'gtm.start': new Date().getTime(), 'event': 'gtm.js'})
        var f = d.getElementsByTagName(s)[0],
          j = d.createElement(s), // nosemgrep: create-script-element
          dl = l != 'dataLayer' ? '&l=' + l : ''
        j.async = true
        j.src = 'https://www.googletagmanager.com/gtm.js?id=' + i + dl
        f.parentNode.insertBefore(j, f)
      })(window, document, 'script', 'dataLayer', 'GTM-NRG742MW') // nosemgrep: create-script-element
    }

    // Conditionally load Segment based on analytics consent
    // SECURITY NOTE: This appears to be dynamic script creation, but it's safe because:
    // 1. The URL is hardcoded to Anthropic's CDN (a-cdn.anthropic.com)
    // 2. The 'key' variable is hardcoded to a known Segment write key
    // 3. Script loading is gated by explicit user analytics consent
    // 4. No user input influences the URL or key
    // This is the standard Segment analytics snippet pattern.
    // Reference: https://segment.com/docs/connections/sources/catalog/libraries/website/javascript/
    if (initialPreferences.analytics) {
      !(function () {
        var i = 'analytics',
          analytics = (window[i] = window[i] || [])
        if (!analytics.initialize)
          if (analytics.invoked)
            window.console && console.error && console.error('Segment snippet included twice.')
          else {
            analytics.invoked = !0
            analytics.methods = [
              'trackSubmit',
              'trackClick',
              'trackLink',
              'trackForm',
              'pageview',
              'identify',
              'reset',
              'group',
              'track',
              'ready',
              'alias',
              'debug',
              'page',
              'screen',
              'once',
              'off',
              'on',
              'addSourceMiddleware',
              'addIntegrationMiddleware',
              'setAnonymousId',
              'addDestinationMiddleware',
              'register',
            ]
            analytics.factory = function (e) {
              return function () {
                if (window[i].initialized) return window[i][e].apply(window[i], arguments)
                var n = Array.prototype.slice.call(arguments)
                if (['track', 'screen', 'alias', 'group', 'page', 'identify'].indexOf(e) > -1) {
                  var c = document.querySelector("link[rel='canonical']")
                  n.push({
                    __t: 'bpc',
                    c: (c && c.getAttribute('href')) || void 0,
                    p: location.pathname,
                    u: location.href,
                    s: location.search,
                    t: document.title,
                    r: document.referrer,
                  })
                }
                n.unshift(e)
                analytics.push(n)
                return analytics
              }
            }
            for (var n = 0; n < analytics.methods.length; n++) {
              var key = analytics.methods[n]
              analytics[key] = analytics.factory(key)
            }
            analytics.load = function (key, n) {
              var t = document.createElement('script') // nosemgrep: create-script-element
              t.type = 'text/javascript'
              t.async = !0
              t.setAttribute('data-global-segment-analytics-key', i)
              t.src = 'https://a-cdn.anthropic.com/analytics.js/v1/' + key + '/analytics.min.js'
              var r = document.getElementsByTagName('script')[0]
              r.parentNode.insertBefore(t, r)
              analytics._loadOptions = n
            }
            analytics._writeKey = 'LKJN8LsLERHEOXkw487o7qCTFOrGPimI'
            analytics.SNIPPET_VERSION = '5.2.0' // nosemgrep: create-script-element
            analytics.load('LKJN8LsLERHEOXkw487o7qCTFOrGPimI', {
              integrations: {'Segment.io': {apiHost: 'a-api.anthropic.com/v1', protocol: 'https'}},
            })
          }
      })()

      // Initialize Amplitude Session Replay (only when analytics consent is granted)
      // Requires the following script to be loaded in Webflow custom code before this script:
      // <script src="https://cdn.amplitude.com/libs/session-replay-browser-1.29.8-min.js.gz" integrity="sha384-EU9HGeIb+45BYhgQSwTf3W0jTMq+IMmYUPPeU5E2JZcx9G99HI5hk5BtL9QVBazu" crossorigin="anonymous"></script>
      if (typeof window.sessionReplay !== 'undefined') {
        // Wait for Segment to be ready to get the session ID and device ID
        window.analytics.ready(function () {
          try {
            // Get session ID from analytics_session_id cookie (set by Segment)
            const sessionIdCookie = cookieUtils.get('analytics_session_id')
            const sessionId = sessionIdCookie ? parseInt(sessionIdCookie, 10) : Date.now()

            // Get device ID from Segment's anonymous ID
            const deviceId = window.analytics.user().anonymousId()

            // Initialize Session Replay with Amplitude API key
            // enableRemoteConfig allows sample rate to be controlled from Amplitude UI
            window.sessionReplay.init('7ce2ea47b889af8cf03ff55258f60f2d', {
              deviceId: deviceId,
              sessionId: sessionId,
              sampleRate: 0,
              enableRemoteConfig: true,
              storeType: 'memory',
            })

            // Store session replay initialization status for use by tracking script
            window.amplitudeSessionReplayInitialized = true
          } catch (e) {
            // Silent fail - session replay is non-critical
            console.warn('[Session Replay] Initialization failed:', e)
          }
        })
      }
    }

    // Initialize Webflow Optimize consent based on analytics preference
    if (typeof window.wf !== 'undefined' && typeof window.wf.ready === 'function') {
      window.wf.ready(() => {
        updateWebflowOptimizeConsent(initialPreferences)
      })
    }

    // Show banner if no cookie exists and user is in explicit consent country
    // Skip banner if GPC is enabled (user has already expressed opt-out preference)
    if (!cookieUtils.has(CONSENT_PREFERENCES_COOKIE_KEY) && !isGlobalPrivacyControlEnabled()) {
      const requiresExplicitConsent = await inExplicitConsentRequiredCountry()
      if (requiresExplicitConsent) {
        showBanner()
      }
    }

    // Event listeners
    const acceptBtn = document.getElementById('accept-btn')
    if (acceptBtn) {
      acceptBtn.addEventListener('click', () => {
        saveConsentPreferences({analytics: true, marketing: true})
      })
    }

    const rejectBtn = document.getElementById('reject-btn')
    if (rejectBtn) {
      rejectBtn.addEventListener('click', () => {
        saveConsentPreferences({analytics: false, marketing: false})
      })
    }

    const customizeBtn = document.getElementById('customize-btn')
    if (customizeBtn) {
      customizeBtn.addEventListener('click', showDetailedOptions)
    }

    const savePreferencesBtn = document.getElementById('save-preferences-btn')
    if (savePreferencesBtn) {
      savePreferencesBtn.addEventListener('click', () => {
        const analyticsConsent = document.getElementById('analytics-consent')
        const marketingConsent = document.getElementById('marketing-consent')

        if (analyticsConsent && marketingConsent) {
          saveConsentPreferences({
            analytics: analyticsConsent.checked,
            marketing: marketingConsent.checked,
          })
        }
      })
    }

    const privacyChoicesBtn = document.getElementById('privacy-choices-btn')
    if (privacyChoicesBtn) {
      privacyChoicesBtn.addEventListener('click', showBanner)
    }

    // Toggle status updates
    ;['analytics-consent', 'marketing-consent'].forEach((id) => {
      const element = document.getElementById(id)
      if (element) {
        element.addEventListener('change', function () {
          const statusId = id.replace('-consent', '-status')
          const statusElement = document.getElementById(statusId)
          if (statusElement) {
            statusElement.textContent = this.checked ? 'On' : 'Off'
          }
        })
      }
    })

    // Escape key handler
    document.addEventListener('keydown', function (event) {
      const dialog = document.getElementById('consent-container')
      if (event.key === 'Escape' && dialog?.open) {
        hideBanner()
      }
    })
  })
})()

/**
 * YouTube Privacy Compliance
 * Converts YouTube embeds to use youtube-nocookie.com for GDPR compliance.
 * This prevents YouTube from setting tracking cookies until the user plays the video.
 *
 * Note: This uses a one-time check on page load rather than a MutationObserver.
 * Dynamically loaded YouTube embeds (e.g., from user interactions) are already
 * handled at the source to use nocookies URLs. A MutationObserver would add
 * continuous performance overhead for minimal benefit.
 */
;(function () {
  'use strict'

  function convertToNoCookie(url) {
    if (!url || url.includes('youtube-nocookie.com')) return url

    // Only convert valid HTTPS YouTube embed URLs (prevents XSS via javascript: URLs)
    if (!/^https?:\/\/(?:www\.)?youtube\.com\/embed\//i.test(url)) return url

    return url.replace(/(?:www\.)?youtube\.com/g, 'www.youtube-nocookie.com')
  }

  window.addEventListener('load', function () {
    try {
      // Match both src and data-src (for lazy-loaded iframes), with or without www prefix
      var selector = 'iframe[src*="youtube.com/embed"], iframe[data-src*="youtube.com/embed"]'
      document.querySelectorAll(selector).forEach(function (iframe) {
        if (iframe.src) {
          iframe.src = convertToNoCookie(iframe.src)
        }
        if (iframe.dataset.src) {
          iframe.dataset.src = convertToNoCookie(iframe.dataset.src)
        }
      })
    } catch (e) {
      // Silently fail - this is a privacy enhancement, not critical functionality
    }
  })
})()
