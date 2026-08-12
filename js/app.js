/**
 * BRFLIX - Core Application JavaScript
 * Dynamic TMDB API integrations, Embed Streaming Players, LocalStorage List, and premium UX interactions.
 */



// Suppress harmless internal errors thrown by third-party ad network scripts (Adsterra)
window.addEventListener('error', function(event) {
    if (
        (event.filename && (event.filename.includes('effectivecpmnetwork') || event.filename.includes('highperformanceformat'))) ||
        (event.message && (event.message.includes('redirectHandler') || event.message.includes('Cannot convert undefined or null')))
    ) {
        event.stopImmediatePropagation();
        event.preventDefault();
        return true;
    }
}, true);

// TMDB image CDN, served through our same-origin proxy (/img-proxy) instead of
// hitting image.tmdb.org directly. Several AdBlock/privacy extensions block
// well-known third-party image CDNs by domain, which was causing every poster
// and backdrop to fail with ERR_BLOCKED_BY_CLIENT. Same-origin sidesteps that.
// Verbose diagnostic logging (player resolution steps, intro-timestamp
// fetches, etc.) — noisy in every visitor's console, and some of it
// (resolved stream URLs with tokens) is better off not sitting there by
// default. Off unless explicitly enabled per-browser for troubleshooting via:
// localStorage.setItem('brflix-debug', '1')
const DEBUG = localStorage.getItem('brflix-debug') === '1';
function debugLog(...args) {
    if (DEBUG) console.log(...args);
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

const IMAGE_BASE_URL = '/img-proxy/tmdb';
// Same reasoning for the few Unsplash placeholders used around the site (default avatar, auth backgrounds).
const UNSPLASH_PROXY_BASE = '/img-proxy/unsplash';

// All TMDB *data* requests go through our own backend (/tmdb-cached/*), which
// caches responses in Postgres (see server/cache.js) to avoid hitting TMDB's
// rate limit under concurrent traffic. The TMDB API key now lives server-side
// only (vite.config.js) and is never shipped to the browser.

const PROVIDERS = {
    'fenixflix': {
        name: 'FenixFlix (Stremio)',
        movie: (id, imdb) => `https://fenixflix.fenixhub.online/stream/movie/${imdb || id}.json`,
        tv: (id, s, e, imdb) => `https://fenixflix.fenixhub.online/stream/series/${imdb || id}:${s}:${e}.json`
    },
    'superflix-lifestyle': {
        name: 'SuperFlix (Lifestyle)',
        movie: (id, imdb) => `https://superflixapi.lifestyle/filme/${imdb || id}`,
        tv: (id, s, e, imdb) => `https://superflixapi.lifestyle/serie/${id}/${s}/${e}`
    },
    'superflix-fit': {
        name: 'SuperFlix (Fit)',
        movie: (id, imdb) => `https://superflixapi.fit/filme/${imdb || id}`,
        tv: (id, s, e, imdb) => `https://superflixapi.fit/serie/${id}/${s}/${e}`
    },
    'warezcdn': {
        name: 'WarezCDN',
        movie: (id, imdb) => `https://warezcdn.lat/filme/${imdb || id}`,
        tv: (id, s, e, imdb) => `https://warezcdn.lat/serie/${id}/${s}/${e}`
    },
    'megaembed': {
        name: 'MegaEmbed',
        movie: (id, imdb) => `https://mgeb.top/embed/${imdb || id}`,
        tv: (id, s, e, imdb) => `https://mgeb.top/embed/${imdb || id}/${s}/${e}`
    },
    'embedmovies': {
        name: 'EmbedMovies',
        movie: (id, imdb) => `https://myembed.biz/filme/${imdb || id}`,
        tv: (id, s, e, imdb) => `https://myembed.biz/serie/${id}/${s}/${e}`
    },
    'clickhost': {
        name: 'ClickHost Embed',
        movie: (id, imdb) => `https://embed-api.clickhost.xyz/embed/filme/${id}`,
        tv: (id, s, e, imdb) => `https://embed-api.clickhost.xyz/embed/serie/${id}/${s}/${e}`
    },
    'native_premium': {
        name: 'Player Principal',
        movie: (id, imdb) => `https://embed-api.clickhost.xyz/embed/filme/${id}`,
        tv: (id, s, e, imdb) => `https://embed-api.clickhost.xyz/embed/serie/${id}/${s}/${e}`
    }
};

// Content Safety: TMDB keyword IDs for explicit/hentai/pornographic content.
// The TMDB 'adult' flag only covers raw pornography and does NOT cover hentai/ecchi anime,
// which are tagged with these specific keywords instead. Used to exclude such content
// from every catalog/discovery listing on the site (strictly forbidden content).
const BLOCKED_ADULT_KEYWORD_IDS = [
    198385, // hentai
    195669, // ecchi
    285672, // etchi
    155477, // softcore
    161919, // adult animation
    362782, // french adult animation
    256466, // erotic
    233305, // mature romance
    329280, // sexual content
    349634, // explicit
    347060, // explicite sex
    5593,   // pornographic video
    277271, // romantic pornographic
    272027, // pornographic animation
    335853, // early pornographic film
    176511, // pornographer
    445,    // pornography
    207767, // erotic thriller
    10053,  // sexploitation
    335048, // sexsploitation
    325693, // erotica
    354470, // sex scene
    364719  // erotic drama
].join(',');

// Content Safety: minimum TMDB vote_count required for a title to appear in any
// /discover listing (trending rows, catalog prefetch, Explorar). TMDB's
// popularity.desc sort can rank barely-reviewed titles (0-2 votes) above
// well-known ones — and in practice, low-effort/obscure foreign uploads with
// pornographic or otherwise inappropriate content are exactly the kind of
// title that has almost no real votes but briefly spikes in 'popularity'.
// Requiring a minimum vote_count filters that whole class out without
// touching any legitimately popular movie/show (which always have hundreds+).
const MIN_DISCOVER_VOTE_COUNT = 20;

// Content Safety: secondary text-based check (title + overview) against explicit/adult terms.
// Acts as defense-in-depth alongside the without_keywords filter used in every /discover call,
// in case TMDB metadata for a title is missing or mistagged. Pornographic content is strictly
// forbidden on this site and must never surface in any listing.
const EXPLICIT_CONTENT_TERMS = ['hentai', 'ecchi', 'porno', 'pornogr', 'x-rated', 'erotic', 'erótic', 'softcore', 'nudity', 'nudez'];
function isExplicitContent(item) {
    if (!item) return true;
    if (item.adult) return true;
    const text = `${item.title || ''} ${item.name || ''} ${item.original_title || ''} ${item.original_name || ''} ${item.overview || ''}`.toLowerCase();
    return EXPLICIT_CONTENT_TERMS.some(term => text.includes(term));
}

// Fallback image placeholders if TMDB fails
const FALLBACK_POSTER = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzAwIiBoZWlnaHQ9IjQ1MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMC9zdmciPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbGw9IiMzMzMzMzMiLz48dGV4dCB4PSI1MCUiIHk9IjUwJSIgZm9udC1mYW1pbHk9IkFyaWFsIiBmb250LXNpemU9IjE0IiBmaWxsPSIjNjY2NjY2IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBkeT0iLjNlbSI+U09NIEZJTElNRTwvdGV4dD48L3N2Zz4=';
const FALLBACK_BACKDROP = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTIwMCIgaGVpZ2h0PSI2NzUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHJlY3Qgd2lkdGg9IjEwMCUiIGhlaWdodD0iMTAwJSIgZmlsbD0iIzMzMzMzMyIvPjwvc3ZnPg==';

// Continue Assistindo Series Configurations (TMDB TV ID Map)
const CONTINUE_WATCHING_DATA = [
    { id: 1396, name: 'Breaking Bad', episode: 'S5:E14', progress: 75, fallbackImage: 'https://image.tmdb.org/t/p/w300/ztkUQFLlC19CCMYHW9o1zWhJRNq.jpg' },
    { id: 66732, name: 'Stranger Things', episode: 'S4:E7', progress: 88, fallbackImage: 'https://image.tmdb.org/t/p/w300/uOOtwVbSr4QDjAGIifLDwpb2Pdl.jpg' },
    { id: 119051, name: 'Wednesday', episode: 'S1:E4', progress: 60, fallbackImage: 'https://image.tmdb.org/t/p/w300/36xXlhEpQqVVPuiZhfoQuaY4OlA.jpg' },
    { id: 136283, name: 'The Last of Us', episode: 'S1:E3', progress: 12, fallbackImage: 'https://image.tmdb.org/t/p/w300/uUM4LVlPgIrww07OoEKrGWlS1Ej.jpg' }
];

// Featured Movies Fallback/Predefined IDs (to guarantee requested films are loaded)
const BRAZILIAN_FEATURED_MOVIES_IDS = [
    872585, // Oppenheimer
    346698, // Barbie
    693134, // Dune: Part Two
    157336, // Interstellar
    27205   // Inception
];

// Predefined Series for "Séries em Alta"
const BRAZILIAN_FEATURED_SERIES_IDS = [
    1396,   // Breaking Bad
    66732,  // Stranger Things
    119051, // Wednesday
    115036, // The Book of Boba Fett
    136283, // The Last of Us
    70523   // Dark
];


let currentIntroData = null; // Stores intro timestamps for the active TV episode
let introShowTimer = null;   // Timer to show the skip button at intro start
let introHideTimer = null;   // Timer to hide the skip button at intro end
let introIframeReady = false; // Whether the iframe has finished loading
let hlsInstance = null; // Global Hls.js playback instance
let currentStreamRequestId = 0; // Request ID to prevent async race conditions
let currentPlayingUrl = ''; // Currently active native player URL to prevent stale error toasts
let isNativeFailoverActive = false; // Flag to silence global error toasts during failover testing
let currentQualityLevelIndex = -1; // -1 = Auto (ABR). Otherwise index into hlsInstance.levels
// Zoom / Fill Screen toggle state (mirrors mobile app's contentFit and the TV app's
// videoResizeMode) — false = 'contain' (whole frame, default), true = 'cover' (crops to
// fill edge-to-edge). Needed for sources with black bars baked directly into the video
// pixels, which no aspect-ratio detection alone can fix — only visually cropping does.
let isZoomFillActive = false;

// Some providers (ClickHost in particular) respond with HTTP 200 and a valid,
// playable mp4 even when the requested title is actually offline — a short
// "servidor temporariamente fora do ar" placeholder clip instead of a proper
// error. Any real movie/episode is always far longer than this, so we use it
// to detect and reject placeholders, forcing an automatic fallback to the next provider.
const MIN_VALID_STREAM_DURATION_SECONDS = 90;

let playerControlsTimer = null;
let isMouseOverControls = false;

// Double-tap-to-seek state (native-click-shield tap detection) — see the
// nativeClickShield click handler further down for the gesture logic itself.
let clickShieldTapTimer = null;
let clickShieldLastTapTime = 0;
let clickShieldLastTapSide = null;
const DOUBLE_TAP_SEEK_WINDOW_MS = 300;

// Briefly flashes the ±10s indicator (native-seek-flash-left/right in index.html)
// to confirm a double-tap seek gesture, then fades it back out.
function flashSeekIndicator(el) {
    if (!el) return;
    el.classList.remove('opacity-0', 'scale-75');
    el.classList.add('opacity-100', 'scale-100');
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => {
        el.classList.remove('opacity-100', 'scale-100');
        el.classList.add('opacity-0', 'scale-75');
    }, 500);
}

function showPlayerControls() {
    if (!playerOverlayControls) return;
    
    // Clear any existing timer
    if (playerControlsTimer) {
        clearTimeout(playerControlsTimer);
        playerControlsTimer = null;
    }
    
    // Fade in the modal header
    if (playerModalHeader) {
        playerModalHeader.classList.remove('opacity-0');
        playerModalHeader.classList.add('opacity-100');
        playerModalHeader.style.pointerEvents = 'auto';
    }

    // Title & episode overlay (shown when moving mouse/activating controls in fullscreen)
    const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
    if (playerFullscreenTitle) {
        if (isFullscreen) {
            if (fsTitleText && currentOpenItem) {
                fsTitleText.textContent = (currentOpenItem.title || '').toUpperCase();
            }
            if (fsSubtitleText && currentOpenItem) {
                if (currentOpenItem.type === 'tv') {
                    let epInfo = `Temporada ${currentEpisodeState.season} • Episódio ${currentEpisodeState.episode}`;
                    if (playerEpisodeSelect && playerEpisodeSelect.selectedOptions && playerEpisodeSelect.selectedOptions[0]) {
                        const selText = playerEpisodeSelect.selectedOptions[0].textContent;
                        if (selText) {
                            epInfo = `Temporada ${currentEpisodeState.season} • ${selText}`;
                        }
                    }
                    fsSubtitleText.textContent = epInfo;
                } else {
                    fsSubtitleText.textContent = 'Filme Completo';
                }
            }
            playerFullscreenTitle.classList.remove('opacity-0');
            playerFullscreenTitle.classList.add('opacity-100');
        } else {
            playerFullscreenTitle.classList.remove('opacity-100');
            playerFullscreenTitle.classList.add('opacity-0');
        }
    }
    
    // Fade in the overlay container (it always has pointer-events-none to let clicks pass through to the iframe)
    playerOverlayControls.classList.remove('opacity-0');
    playerOverlayControls.classList.add('opacity-100');
    
    // Fade in native controls if active
    if (playerNativeControls && !playerNativeControls.classList.contains('hidden')) {
        playerNativeControls.classList.remove('opacity-0');
        playerNativeControls.classList.add('opacity-100');
    }
    
    // Disable pointer-events on mouse-layer so clicks pass through to the iframe/video when controls are visible
    if (playerMouseLayer) {
        playerMouseLayer.style.pointerEvents = 'none';
    }
    
    // Enable click events on buttons when they are visible
    [playerPrevEpBtn, playerNextEpBtn, playerSkipIntroBtn, playerCustomFullscreenBtn].forEach(btn => {
        if (btn) {
            btn.classList.remove('pointer-events-none');
            btn.classList.add('pointer-events-auto');
        }
    });
    
    // Enable click events on native player buttons and wrappers
    [nativePlayBtn, nativeRewindBtn, nativeForwardBtn, nativeVolumeBtn, nativeVolumeSlider, nativeFullscreenBtn, nativeZoomBtn, nativeSkipIntroBtn, nativeQualityBtn, nativeAudioBtn, nativeSubtitleBtn, nativePrevEpBtn, nativeNextEpBtn, nativeTimelineContainer].forEach(btn => {
        if (btn) {
            btn.classList.remove('pointer-events-none');
            btn.classList.add('pointer-events-auto');
        }
    });
    [nativeClickShield, nativeBottomBar].forEach(el => {
        if (el) {
            el.classList.remove('pointer-events-none');
            el.classList.add('pointer-events-auto');
            el.style.pointerEvents = 'auto';
        }
    });
    
    // Determine if prev/next buttons should be visible (only for TV/Anime)
    if (currentOpenItem && currentOpenItem.type === 'tv') {
        if (playerPrevEpBtn) playerPrevEpBtn.style.display = 'flex';
        if (playerNextEpBtn) playerNextEpBtn.style.display = 'flex';
    } else {
        if (playerPrevEpBtn) playerPrevEpBtn.style.display = 'none';
        if (playerNextEpBtn) playerNextEpBtn.style.display = 'none';
    }
    
    // Hide controls after 3 seconds of inactivity, unless mouse is hovering over control buttons
    if (!isMouseOverControls) {
        playerControlsTimer = setTimeout(hidePlayerControls, 3000);
    }
}

function hidePlayerControls() {
    if (!playerOverlayControls) return;
    
    // Do not hide if mouse is over controls
    if (isMouseOverControls) return;
    
    // Fade out the modal header
    if (playerModalHeader) {
        playerModalHeader.classList.remove('opacity-100');
        playerModalHeader.classList.add('opacity-0');
        playerModalHeader.style.pointerEvents = 'none';
    }

    // Fade out fullscreen title & episode overlay
    if (playerFullscreenTitle) {
        playerFullscreenTitle.classList.remove('opacity-100');
        playerFullscreenTitle.classList.add('opacity-0');
    }
    
    // Fade out the overlay container
    playerOverlayControls.classList.remove('opacity-100');
    playerOverlayControls.classList.add('opacity-0');
    
    // Fade out native controls if active
    if (playerNativeControls && !playerNativeControls.classList.contains('hidden')) {
        playerNativeControls.classList.remove('opacity-100');
        playerNativeControls.classList.add('opacity-0');
    }
    
    // Enable pointer-events on mouse-layer to capture mouse movements when controls are hidden
    if (playerMouseLayer) {
        playerMouseLayer.style.pointerEvents = 'auto';
    }
    
    // Disable clicks on buttons when they are invisible
    [playerPrevEpBtn, playerNextEpBtn, playerSkipIntroBtn, playerCustomFullscreenBtn].forEach(btn => {
        if (btn) {
            btn.classList.remove('pointer-events-auto');
            btn.classList.add('pointer-events-none');
        }
    });
    
    // Disable clicks on native player buttons and wrappers
    [nativePlayBtn, nativeRewindBtn, nativeForwardBtn, nativeVolumeBtn, nativeVolumeSlider, nativeFullscreenBtn, nativeZoomBtn, nativeSkipIntroBtn, nativeQualityBtn, nativeAudioBtn, nativePrevEpBtn, nativeNextEpBtn, nativeTimelineContainer].forEach(btn => {
        if (btn) {
            btn.classList.remove('pointer-events-auto');
            btn.classList.add('pointer-events-none');
        }
    });
    [nativeClickShield, nativeBottomBar].forEach(el => {
        if (el) {
            el.classList.remove('pointer-events-auto');
            el.classList.add('pointer-events-none');
            el.style.pointerEvents = 'none';
        }
    });
}

function clearIntroTimers() {
    if (introShowTimer) { clearTimeout(introShowTimer); introShowTimer = null; }
    if (introHideTimer) { clearTimeout(introHideTimer); introHideTimer = null; }
    if (playerControlsTimer) { clearTimeout(playerControlsTimer); playerControlsTimer = null; }
    if (playerSkipIntroBtn) playerSkipIntroBtn.style.display = 'none';
    
    // Hide overlay immediately
    if (playerOverlayControls) {
        playerOverlayControls.classList.remove('opacity-100');
        playerOverlayControls.classList.add('opacity-0');
    }
    
    // Disable clicks on buttons
    [playerPrevEpBtn, playerNextEpBtn, playerSkipIntroBtn, playerCustomFullscreenBtn].forEach(btn => {
        if (btn) {
            btn.classList.remove('pointer-events-auto');
            btn.classList.add('pointer-events-none');
        }
    });
}

function toggleFullscreen() {
    if (!playerVideoArea) return;
    
    const isFullscreen = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;
    
    if (!isFullscreen) {
        // Request fullscreen on parent video area container so overlays stay visible.
        // iOS Safari (iPhone) does NOT implement the Fullscreen API on arbitrary elements —
        // only <video> exposes webkitEnterFullscreen() there, which hands off to its own
        // native OS-level player. Detect that and fall back to it instead of silently doing nothing.
        const supportsContainerFullscreen = playerVideoArea.requestFullscreen || playerVideoArea.mozRequestFullScreen || playerVideoArea.webkitRequestFullscreen || playerVideoArea.msRequestFullscreen;
        if (supportsContainerFullscreen) {
            if (playerVideoArea.requestFullscreen) {
                playerVideoArea.requestFullscreen();
            } else if (playerVideoArea.mozRequestFullScreen) {
                playerVideoArea.mozRequestFullScreen();
            } else if (playerVideoArea.webkitRequestFullscreen) {
                playerVideoArea.webkitRequestFullscreen();
            } else if (playerVideoArea.msRequestFullscreen) {
                playerVideoArea.msRequestFullscreen();
            }
        } else if (playerNative && !playerNative.classList.contains('hidden') && playerNative.webkitEnterFullscreen) {
            playerNative.webkitEnterFullscreen();
        }
        
        // Best-effort landscape lock on phones for a proper cinema view — ignored where
        // unsupported (desktop, iOS Safari) or rejected by the browser; non-critical either way.
        if (screen.orientation && screen.orientation.lock) {
            screen.orientation.lock('landscape').catch(() => {});
        }
    } else {
        // Exit fullscreen
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.mozCancelFullScreen) {
            document.mozCancelFullScreen();
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        } else if (document.msExitFullscreen) {
            document.msExitFullscreen();
        }
        if (screen.orientation && screen.orientation.unlock) {
            try { screen.orientation.unlock(); } catch (e) { /* no-op */ }
        }
    }
}

function handleFullscreenChange() {
    const isFullscreen = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;
    if (playerCustomFullscreenBtn) {
        const icon = playerCustomFullscreenBtn.querySelector('i');
        if (icon) {
            if (isFullscreen) {
                icon.classList.remove('fa-expand');
                icon.classList.add('fa-compress');
            } else {
                icon.classList.remove('fa-compress');
                icon.classList.add('fa-expand');
            }
        }
    }
    if (isFullscreen) {
        showPlayerControls();
    } else {
        if (playerFullscreenTitle) {
            playerFullscreenTitle.classList.remove('opacity-100');
            playerFullscreenTitle.classList.add('opacity-0');
        }
        // Force orientation unlock & viewport height reset when exiting fullscreen on mobile
        if (screen.orientation && screen.orientation.unlock) {
            try { screen.orientation.unlock(); } catch (e) {}
        }
        if (playerModal) {
            playerModal.style.height = '100dvh';
        }
        window.scrollTo(0, 0);
    }
}

// Called when the iframe finishes loading — starts the intro countdown
function scheduleIntroButton() {
    if (!currentIntroData || currentIntroData.start_ms === null || currentIntroData.end_ms === null) return;
    
    clearIntroTimers();
    
    const startMs = currentIntroData.start_ms;
    const endMs = currentIntroData.end_ms;
    
    debugLog(`[SkipIntro] Scheduling button: show at ${startMs}ms, hide at ${endMs}ms`);
    
    // Show button when intro starts
    introShowTimer = setTimeout(() => {
        if (playerSkipIntroBtn && currentIntroData) {
            playerSkipIntroBtn.style.display = 'flex';
            debugLog('[SkipIntro] ▶ Intro started — showing skip button');
            showPlayerControls(); // Fade in controls when skip button appears
        }
    }, startMs);
    
    // Hide button when intro ends
    introHideTimer = setTimeout(() => {
        if (playerSkipIntroBtn) {
            playerSkipIntroBtn.style.display = 'none';
            debugLog('[SkipIntro] ■ Intro ended — hiding skip button');
        }
    }, endMs);
}

async function checkIntroTimestamps(tmdbId, season, episode) {
    currentIntroData = null;
    introIframeReady = false;
    clearIntroTimers();
    
    // Routed through our own same-origin proxy (backed by an explicit host
    // allowlist server-side) instead of the public third-party corsproxy.io —
    // that relay isn't affiliated with us and would otherwise see every
    // skip-intro lookup this app makes.
    const proxyUrl = `/dynamic-proxy/api.theintrodb.org/v1/media?tmdb_id=${tmdbId}&season=${season}&episode=${episode}`;
    const directUrl = `https://api.theintrodb.org/v1/media?tmdb_id=${tmdbId}&season=${season}&episode=${episode}`;

    debugLog(`[SkipIntro] Fetching intro data for TMDB ${tmdbId} S${season}E${episode}...`);
    
    let data = null;
    
    // api.theintrodb.org explicitly allows CORS for this site's origin, so the
    // direct browser fetch normally succeeds on its own. It blocks requests
    // from datacenter/VPS IPs though, so our own server-side proxy ALWAYS gets
    // a 403 there — kept only as a fallback (e.g. if CORS is ever revoked),
    // tried second so it doesn't produce a guaranteed, noisy console error on
    // every single episode load.
    for (const url of [directUrl, proxyUrl]) {
        try {
            const response = await fetch(url);
            debugLog(`[SkipIntro] ${url.startsWith('/dynamic-proxy') ? 'Proxy' : 'Direct'} response status: ${response.status}`);
            if (response.ok) {
                data = await response.json();
                break;
            }
        } catch (err) {
            console.warn(`[SkipIntro] Fetch failed for ${url.startsWith('/dynamic-proxy') ? 'proxy' : 'direct'}:`, err.message);
        }
    }
    
    if (data) {
        debugLog('[SkipIntro] API response:', data);
        if (data.intro && data.intro.start_ms !== null && data.intro.end_ms !== null) {
            currentIntroData = data.intro;
            debugLog(`[SkipIntro] ✓ Intro found: ${data.intro.start_ms}ms → ${data.intro.end_ms}ms (button will appear at playback time)`);
            // If iframe already loaded, schedule immediately
            if (introIframeReady) {
                scheduleIntroButton();
            }
        } else {
            debugLog('[SkipIntro] No intro timestamps available for this episode.');
        }
    } else {
        console.warn('[SkipIntro] Could not fetch intro data from any source.');
    }
}

function skipIntro() {
    if (!currentIntroData || currentIntroData.end_ms === null) return;
    
    // Clear timers since user is skipping
    clearIntroTimers();
    
    const skipSeconds = Math.floor(currentIntroData.end_ms / 1000);
    const mins = Math.floor(skipSeconds / 60);
    const secs = skipSeconds % 60;
    const timeString = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    
    // Show a helpful toast telling the user the exact timestamp of the end of the intro
    showToast(`⏱️ Abertura termina em ${timeString}. Adiante o vídeo até lá!`);
    
    if (playerSkipIntroBtn) {
        playerSkipIntroBtn.style.display = 'none';
    }
    
    currentIntroData = null; // Prevent re-scheduling after skip
}

async function playNextEpisode() {
    const curSeason = parseInt(playerSeasonSelect.value);
    const curEpisode = parseInt(playerEpisodeSelect.value);
    
    const epOptions = Array.from(playerEpisodeSelect.options).map(opt => parseInt(opt.value));
    const maxEpisode = Math.max(...epOptions, 1);
    
    if (curEpisode < maxEpisode) {
        const nextEpisode = curEpisode + 1;
        playerEpisodeSelect.value = nextEpisode;
        currentEpisodeState.episode = nextEpisode;
        loadPlayerStream();
    } else {
        const seasonOptions = Array.from(playerSeasonSelect.options).map(opt => parseInt(opt.value));
        const maxSeason = Math.max(...seasonOptions, 1);
        if (curSeason < maxSeason) {
            const nextSeason = curSeason + 1;
            playerSeasonSelect.value = nextSeason;
            currentEpisodeState.season = nextSeason;
            currentEpisodeState.episode = 1;
            await loadEpisodeList(currentOpenItem.id, nextSeason, 1);
            loadPlayerStream();
        } else {
            debugLog("Último episódio da série alcançado!");
        }
    }
}

async function playPrevEpisode() {
    const curSeason = parseInt(playerSeasonSelect.value);
    const curEpisode = parseInt(playerEpisodeSelect.value);
    
    if (curEpisode > 1) {
        const prevEpisode = curEpisode - 1;
        playerEpisodeSelect.value = prevEpisode;
        currentEpisodeState.episode = prevEpisode;
        loadPlayerStream();
    } else {
        const seasonOptions = Array.from(playerSeasonSelect.options).map(opt => parseInt(opt.value));
        const minSeason = Math.min(...seasonOptions, 1);
        if (curSeason > minSeason) {
            const prevSeason = curSeason - 1;
            playerSeasonSelect.value = prevSeason;
            currentEpisodeState.season = prevSeason;
            
            await loadEpisodeList(currentOpenItem.id, prevSeason, 1);
            const epOptions = Array.from(playerEpisodeSelect.options).map(opt => parseInt(opt.value));
            const lastEpisodeOfPrevSeason = Math.max(...epOptions, 1);
            
            playerEpisodeSelect.value = lastEpisodeOfPrevSeason;
            currentEpisodeState.episode = lastEpisodeOfPrevSeason;
            loadPlayerStream();
        } else {
            debugLog("Primeiro episódio da série alcançado!");
        }
    }
}

// Application State
// myPlaylist is now backed by the server (/api/favorites, the same endpoint the
// mobile app uses) instead of localStorage — this is what makes an item saved
// on one platform show up on the other for the same account. Populated by
// loadPlaylist() on page load and kept in sync locally after each toggle, so
// every synchronous myPlaylist read across this file keeps working unchanged.
let myPlaylist = [];
let currentOpenItem = null; // Currently selected movie/tv details
let currentEpisodeState = { season: 1, episode: 1 }; // Track current playing series state
let isPlayerWatching = false; // True while the player modal is open — reported to the admin dashboard via the presence heartbeat
let lastKnownAdBlockStatus = null; // Cached result of the last detectAdBlock() run, reused by the heartbeat instead of re-probing
let isSubscriptionTabInitialized = false; // Flag to prevent double-binding click events on subscription page

// DOM Elements
const mainHeader = document.getElementById('main-header');
const searchInput = document.getElementById('search-input');
const searchDropdown = document.getElementById('search-results-dropdown');
const vrBtn = document.getElementById('vr-btn');
const notificationBtn = document.getElementById('notification-btn');
const notificationDropdown = document.getElementById('notification-dropdown');
const clearNotifications = document.getElementById('clear-notifications');
const profileDropdownBtn = document.getElementById('profile-dropdown-btn');
const profileDropdown = document.getElementById('profile-dropdown');
const mobileMenuBtn = document.getElementById('mobile-menu-btn');
const mobileMenu = document.getElementById('mobile-menu');
const closeMobileMenu = document.getElementById('close-mobile-menu');
const currentYearSpan = document.getElementById('current-year');

// Carousel Controls
const moviesCarousel = document.getElementById('movies-carousel');
const seriesCarousel = document.getElementById('series-carousel');
const continueWatchingSection = document.getElementById('continue-watching-section');
const popularMoviesSection = document.getElementById('popular-movies-section');
const myListCarousel = document.getElementById('minha-lista-carousel');
const animesHomeCarousel = document.getElementById('animes-home-carousel');
const myListSection = document.getElementById('minha-lista-section');
const clearListBtn = document.getElementById('clear-list-btn');

// Details Modal Elements
const detailsModal = document.getElementById('details-modal');
const closeDetailsBtn = document.getElementById('close-details-btn');
const modalBanner = document.getElementById('modal-banner');
const modalPoster = document.getElementById('modal-poster');
const modalTypeBadge = document.getElementById('modal-type-badge');
const modalTitle = document.getElementById('modal-title');
const modalYear = document.getElementById('modal-year');
const modalDuration = document.getElementById('modal-duration');
const modalRating = document.getElementById('modal-rating');
const modalClassification = document.getElementById('modal-classification');
const modalOverview = document.getElementById('modal-overview');
const modalGenres = document.getElementById('modal-genres');
const modalPlayBtn = document.getElementById('modal-play-btn');
const modalListBtn = document.getElementById('modal-list-btn');
const modalRecommendations = document.getElementById('modal-recommendations');

// Details Modal TV Selectors
const modalTvControls = document.getElementById('modal-tv-controls');
const modalSeasonSelect = document.getElementById('modal-season-select');
const modalEpisodeSelect = document.getElementById('modal-episode-select');

// Player Modal Elements
const playerModal = document.getElementById('player-modal');
const closePlayerBtn = document.getElementById('close-player-btn');
const playerTitle = document.getElementById('player-title');
const playerSubtitle = document.getElementById('player-subtitle');
const playerServerSelect = document.getElementById('player-server-select');
const playerTvControls = document.getElementById('player-tv-controls');
const playerSeasonSelect = document.getElementById('player-season-select');
const playerEpisodeSelect = document.getElementById('player-episode-select');
const playerLoader = document.getElementById('player-loader');
const playerIframe = document.getElementById('player-iframe');
const playerNative = document.getElementById('player-native');
const playerPrevEpBtn = document.getElementById('player-prev-ep-btn');
const playerNextEpBtn = document.getElementById('player-next-ep-btn');
const playerSkipIntroBtn = document.getElementById('player-skip-intro-btn');
const playerVideoArea = document.getElementById('player-video-area');
const playerOverlayControls = document.getElementById('player-overlay-controls');
const playerCustomFullscreenBtn = document.getElementById('player-custom-fullscreen-btn');
const playerFullscreenShield = document.getElementById('player-fullscreen-shield');
const playerMouseLayer = document.getElementById('player-mouse-layer');

// Custom Native Player Controls Bindings
const playerNativeControls = document.getElementById('player-native-controls');
const playerModalHeader = document.getElementById('player-modal-header');
const playerFullscreenTitle = document.getElementById('player-fullscreen-title');
const fsTitleText = document.getElementById('fs-title-text');
const fsSubtitleText = document.getElementById('fs-subtitle-text');
const nativeBottomBar = document.getElementById('native-bottom-bar');
const nativeClickShield = document.getElementById('native-click-shield');
const nativeCenterPlayBtn = document.getElementById('native-center-play-btn');
const nativeSeekFlashLeft = document.getElementById('native-seek-flash-left');
const nativeSeekFlashRight = document.getElementById('native-seek-flash-right');
const nativeTimeCurrent = document.getElementById('native-time-current');
const nativeTimeTotal = document.getElementById('native-time-total');
const nativeTimelineContainer = document.getElementById('native-timeline-container');
const nativeTimelineBuffered = document.getElementById('native-timeline-buffered');
const nativeTimelineProgress = document.getElementById('native-timeline-progress');
const nativePlayBtn = document.getElementById('native-play-btn');
const nativeRewindBtn = document.getElementById('native-rewind-btn');
const nativeForwardBtn = document.getElementById('native-forward-btn');
const nativeTvControls = document.getElementById('native-tv-controls');
const nativeTvControlsPrev = document.getElementById('native-tv-controls-prev');
const nativePrevEpBtn = document.getElementById('native-prev-ep-btn');
const nativeNextEpBtn = document.getElementById('native-next-ep-btn');
const nativeVolumeBtn = document.getElementById('native-volume-btn');
const nativeVolumeSlider = document.getElementById('native-volume-slider');
const nativeSkipIntroBtn = document.getElementById('native-skip-intro-btn');
const nativeFullscreenBtn = document.getElementById('native-fullscreen-btn');
const nativeZoomBtn = document.getElementById('native-zoom-btn');
const nativeQualityWrapper = document.getElementById('native-quality-wrapper');
const nativeQualityBtn = document.getElementById('native-quality-btn');
const nativeQualityLabel = document.getElementById('native-quality-label');
const nativeQualityMenu = document.getElementById('native-quality-menu');
const nativeAudioWrapper = document.getElementById('native-audio-wrapper');
const nativeAudioBtn = document.getElementById('native-audio-btn');
const nativeAudioLabel = document.getElementById('native-audio-label');
const nativeAudioMenu = document.getElementById('native-audio-menu');
const nativeSubtitleWrapper = document.getElementById('native-subtitle-wrapper');
const nativeSubtitleBtn = document.getElementById('native-subtitle-btn');
const nativeSubtitleLabel = document.getElementById('native-subtitle-label');
const nativeSubtitleMenu = document.getElementById('native-subtitle-menu');

// Set Current Year in Footer
if (currentYearSpan) currentYearSpan.textContent = new Date().getFullYear();

// Fetch Wrapper with Error Handling — routed through our cached backend proxy
async function fetchFromTMDB(endpoint, queryParams = {}) {
    try {
        // Content Safety: always request adult content to be excluded by default.
        // Individual call sites can still override this if ever needed, but none should.
        const safeParams = { include_adult: 'false', ...queryParams };
        const queryStr = Object.entries(safeParams)
            .map(([key, val]) => `${key}=${encodeURIComponent(val)}`)
            .join('&');
        const url = `/tmdb-cached${endpoint}${queryStr ? '?' + queryStr : ''}`;
        
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        return await response.json();
    } catch (error) {
        console.error(`Failed to fetch from TMDB endpoint: ${endpoint}`, error);
        return null;
    }
}

/**
 * AUTH / SESSION HELPERS
 * The session token lives in localStorage ('brflix-token'); the authenticated
 * user object is cached alongside it ('brflix-user') so the many synchronous
 * `JSON.parse(localStorage.getItem('brflix-user'))` reads across the app keep
 * working without turning every call site into an async function. The cache
 * is refreshed from the server on load and after every auth action — the
 * password itself is never stored client-side, only the server-issued token.
 */
function getAuthToken() {
    return localStorage.getItem('brflix-token');
}

async function apiFetch(path, options = {}) {
    const token = getAuthToken();
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const response = await fetch(path, { ...options, headers });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(data.error || `Erro na requisição (${response.status})`);
    }
    return data;
}

/** Validates the cached session token against the server on page load. Clears it if invalid/expired. */
async function restoreSession() {
    const token = getAuthToken();
    if (!token) {
        localStorage.removeItem('brflix-user');
        return;
    }
    try {
        const { user } = await apiFetch('/api/auth/me');
        localStorage.setItem('brflix-user', JSON.stringify(user));
    } catch (err) {
        console.warn('[Auth] Session invalid or expired, logging out locally:', err.message);
        localStorage.removeItem('brflix-token');
        localStorage.removeItem('brflix-user');
    }
}

/**
 * INITIALIZATION FUNCTIONS
 */

document.addEventListener('DOMContentLoaded', async () => {
    // Validate any cached session token against the server before anything else
    // renders, so every synchronous 'brflix-user' read below reflects real, verified auth state.
    await restoreSession();
    // Must resolve before initFeaturedHero/openDetailsModal render their "na lista"
    // button state, so it's correct on first paint instead of only after a toggle.
    await loadPlaylist();
    
    updateHeaderAvatar();
    
    initHeaderScroll();
    initFeaturedHero();
    initContinueWatching();
    initPopularMovies();
    initTrendingSeries();
    initTrendingAnimesHome();
    initDropdowns();
    initSearch();
    initSliders();
    initPlaylist();
    initPlayerEvents();
    initCalendarNotifications();
    
    // Page catalog pre-fetchers (silent in background). Explorar's discovery
    // grid depends on all three catalogs, so they're batched in one Promise.all
    // and flagged ready once every fetch settles (avoids duplicate network hits).
    Promise.all([fetchFilmesCatalog(), fetchSeriesCatalog(), fetchAnimesCatalog()]).then(() => {
        // Wire up Filmes/Séries filters for real-time update (if they exist)
        const fGenre = document.getElementById('filter-filmes-genre');
        const fYear = document.getElementById('filter-filmes-year');
        const fSort = document.getElementById('filter-filmes-sort');
        if (fGenre) fGenre.addEventListener('change', renderFilmesPage);
        if (fYear) fYear.addEventListener('change', renderFilmesPage);
        if (fSort) fSort.addEventListener('change', renderFilmesPage);

        const sGenre = document.getElementById('filter-series-genre');
        const sSort = document.getElementById('filter-series-sort');
        if (sGenre) sGenre.addEventListener('change', renderSeriesPage);
        if (sSort) sSort.addEventListener('change', renderSeriesPage);

        // Top 10 rows for the Filmes/Séries/Animes tabs reuse these same cached
        // catalogs (already popularity-sorted from TMDB), so they're ready to
        // render as soon as the fetch settles, regardless of which tab is active.
        renderTop10Filmes();
        renderTop10Series();
        renderTop10Animes();

        exploreCatalogsLoaded = true;
        if (window.location.hash === '#/explorar') applyExploreFilters();
    });
    
    initAuth();
    initExplorePage();
    initSettingsPage();

    // Runs after restoreSession() above so the ad_free check reflects the
    // latest verified account state; delayed slightly so it doesn't compete
    // with the initial render/paint.
    setTimeout(initAdBlockDetector, 800);
    setTimeout(initDiscordDailyModal, 1200);
    setTimeout(initAds, 800);
    startPresenceHeartbeat();
    
    // Setup Router
    initRouter();
});

// 1. Header scroll effect
function initHeaderScroll() {
    window.addEventListener('scroll', () => {
        if (window.scrollY > 50) {
            mainHeader.classList.add('header-scrolled');
        } else {
            mainHeader.classList.remove('header-scrolled');
        }
    });
}

// 2. Initialize Hero (Cangaço Novo - TV show ID: 211684)
async function initFeaturedHero() {
    // Lista de destaques para rotação: Filmes e Séries famosas (sem anime)
    const featuredItems = [
        { id: 157336, type: 'movie', name: 'Interstellar', fallbackYear: '2014', popularity: 8.4 },  // Filme famoso
        { id: 66732, type: 'tv', name: 'Stranger Things', fallbackYear: '2016', popularity: 8.6 },    // Série famosa  
        { id: 155, type: 'movie', name: 'The Dark Knight', fallbackYear: '2008', popularity: 8.5 },  // Filme famoso
        { id: 1396, type: 'tv', name: 'Breaking Bad', fallbackYear: '2008', popularity: 8.9 },      // Série famosa
        { id: 244786, type: 'movie', name: 'Whiplash', fallbackYear: '2014', popularity: 8.5 },     // Filme aclamado
        { id: 1399, type: 'tv', name: 'Game of Thrones', fallbackYear: '2011', popularity: 8.4 }    // Série famosa
    ];
    
    // Seleciona aleatoriamente um destaque
    const randomIndex = Math.floor(Math.random() * featuredItems.length);
    const featured = featuredItems[randomIndex];
    
    const data = await fetchFromTMDB(`/${featured.type}/${featured.id}`);
    
    const heroPlayBtn = document.getElementById('hero-play-btn');
    const heroPlayBtnSpan = heroPlayBtn.querySelector('span'); // Texto do botão "ASSISTIR S1:E1"
    const heroListBtn = document.getElementById('hero-list-btn');
    const heroInfoBtn = document.getElementById('hero-info-btn');
    const heroTitleDiv = document.getElementById('hero-title');
    const heroOverviewP = document.getElementById('hero-overview');
    const heroMetadataP = document.getElementById('hero-metadata');
    const heroBg = document.getElementById('hero-bg');
    
    if (data) {
        // Set dynamic layout
        const backdropPath = data.backdrop_path ? `${IMAGE_BASE_URL}/original${data.backdrop_path}` : FALLBACK_BACKDROP;
        heroBg.style.backgroundImage = `url('${backdropPath}')`;
        
        // Render stacked titles
        const title = data.title || data.name; // TMDB: movies use 'title', TV uses 'name'
        const titleParts = title.toUpperCase().split(' ');
        if (titleParts.length >= 2) {
            heroTitleDiv.innerHTML = `<span>${titleParts[0]}</span><span class="text-brand">${titleParts.slice(1).join(' ')}</span>`;
        } else {
            heroTitleDiv.innerHTML = `<span>${title.toUpperCase()}</span>`;
        }
        
        heroOverviewP.textContent = data.overview || heroOverviewP.textContent;
        
        // Atualiza texto do botão de play dinamicamente
        if (heroPlayBtnSpan) {
            heroPlayBtnSpan.textContent = featured.type === 'movie' ? 'ASSISTIR' : 'ASSISTIR S1:E1';
        }
        
        const year = featured.type === 'movie' ? 
            (data.release_date ? data.release_date.split('-')[0] : featured.fallbackYear) : 
            (data.first_air_date ? data.first_air_date.split('-')[0] : featured.fallbackYear);
        const rating = data.vote_average ? data.vote_average.toFixed(1) : '8.4';
        const runtimeOrSeasons = featured.type === 'movie' ? 
            (data.runtime ? `${Math.floor(data.runtime / 60)}h ${data.runtime % 60}m` : '2h 10m') : 
            (data.number_of_seasons ? `${data.number_of_seasons} Temporada${data.number_of_seasons > 1 ? 's' : ''}` : '1 Temporada');
        
        heroMetadataP.innerHTML = `
            <span>${featured.type === 'movie' ? 'Filme Original' : 'Série Original'}</span>
            <span class="text-white/30">|</span>
            <span>${data.genres ? data.genres.slice(0, 2).map(g => g.name).join(', ') : 'Ação, Drama'}</span>
            <span class="text-white/30">|</span>
            <span>${year}</span>
            <span class="text-white/30">|</span>
            <span class="px-1.5 py-0.5 bg-zinc-800 text-white rounded text-[10px] font-bold">18+</span>
            <span class="text-white/30">|</span>
            <span>${runtimeOrSeasons}</span>
            <span class="text-white/30">|</span>
            <span class="text-rating"><i class="fa-solid fa-star mr-1"></i>${rating}</span>
        `;
        
        // Play action - usa onclick para evitar múltiplos listeners
        heroPlayBtn.onclick = () => {
            playMedia(data.id, featured.type, data.title || data.name, 1, 1);
        };
        
        // Playlist Toggle action
        updateHeroListButton(data.id);
        heroListBtn.onclick = async (e) => {
            e.stopPropagation();
            await togglePlaylistItem({
                id: data.id,
                title: data.title || data.name,
                poster_path: data.poster_path,
                backdrop_path: data.backdrop_path,
                type: featured.type,
                vote_average: data.vote_average,
                release_date: featured.type === 'movie' ? data.release_date : data.first_air_date
            });
            updateHeroListButton(data.id);
        };

        // Info button action
        heroInfoBtn.onclick = () => {
            openDetailsModal(data.id, featured.type);
        };
    } else {
        // Simple fallback wiring if TMDB call fails
        heroPlayBtn.onclick = () => {
            playMedia(featured.id, featured.type, featured.name, 1, 1);
        };
        
        // Atualiza texto do botão de play no fallback também
        if (heroPlayBtnSpan) {
            heroPlayBtnSpan.textContent = featured.type === 'movie' ? 'ASSISTIR' : 'ASSISTIR S1:E1';
        }
        heroInfoBtn.onclick = () => {
            openDetailsModal(featured.id, featured.type);
        };
        heroListBtn.onclick = async () => {
            await togglePlaylistItem({
                id: featured.id,
                title: featured.name,
                poster_path: null,
                backdrop_path: null,
                type: featured.type,
                vote_average: 8.4,
                release_date: featured.fallbackYear + '-01-01'
            });
            updateHeroListButton(featured.id);
        };
    }
}

function updateHeroListButton(id) {
    const heroListBtn = document.getElementById('hero-list-btn');
    if (!heroListBtn) return;
    const isAdded = myPlaylist.some(item => item.id === id);
    if (isAdded) {
        heroListBtn.innerHTML = `<i class="fa-solid fa-check text-brand"></i><span>NA MINHA LISTA</span>`;
    } else {
        heroListBtn.innerHTML = `<i class="fa-solid fa-plus"></i><span>ADICIONAR À LISTA</span>`;
    }
}

// 3. Initialize "Continue Assistindo" (Left column)
// 3. Initialize "Continue Assistindo" (Left column)
let isContinueWatchingInitializing = false;
async function initContinueWatching() {
    // Prevenir execuções concorrentes que causam duplicação
    if (isContinueWatchingInitializing) {
        debugLog('initContinueWatching already running, skipping');
        return;
    }
    
    isContinueWatchingInitializing = true;
    
    try {
    // Função auxiliar para garantir que as classes de layout sejam aplicadas
    function applyLayoutClasses() {
        const continueWatchingSection = document.getElementById('continue-watching-section');
        const popularMoviesSection = document.getElementById('popular-movies-section');
        
        if (!continueWatchingSection || !popularMoviesSection) {
            console.warn('Continue Watching sections not found, retrying...');
            setTimeout(applyLayoutClasses, 100);
            return;
        }
        
        const user = JSON.parse(localStorage.getItem('brflix-user'));
        
        if (!user) {
            // Usuário não logado: esconde coluna esquerda, expande direita para 12 colunas
            continueWatchingSection.classList.add('hidden');
            popularMoviesSection.classList.remove('lg:col-span-8');
            popularMoviesSection.classList.add('lg:col-span-12');
        } else {
            // Usuário logado: mostra coluna esquerda, ajusta direita para 8 colunas
            continueWatchingSection.classList.remove('hidden');
            popularMoviesSection.classList.remove('lg:col-span-12');
            popularMoviesSection.classList.add('lg:col-span-8');
        }
        
        debugLog('Continue Watching layout applied:', user ? 'logged in' : 'not logged in');
    }
    
    // Primeiro aplica as classes de layout
    applyLayoutClasses();
    
    // Depois popula o conteúdo
    const container = document.getElementById('continue-watching-container');
    if (!container) {
        console.warn('Continue Watching container not found');
        return;
    }
    
    const user = JSON.parse(localStorage.getItem('brflix-user'));
    
    // Check if user is logged in - if not, return early (applyLayoutClasses already hid the section)
    if (!user) {
        return;
    }
    
    container.innerHTML = ''; // Clear skeleton/previous state
    
    const storageKey = `brflix-continue-watching-${user.email}`;
    let list = JSON.parse(localStorage.getItem(storageKey));
    
    // Fallback/initial list setup if none exists
    if (!list || list.length === 0) {
        list = [...CONTINUE_WATCHING_DATA];
    }
    
    // De-duplicate list by ID
    const uniqueList = [];
    const seenIds = new Set();
    for (const item of list) {
        if (item && item.id && !seenIds.has(item.id)) {
            seenIds.add(item.id);
            uniqueList.push(item);
        }
    }
    list = uniqueList.slice(0, 5); // Cap at 5 unique items
    localStorage.setItem(storageKey, JSON.stringify(list));
    
    for (const show of list) {
        // Fallback checks
        const tmdbType = show.episode === 'Filme Completo' ? 'movie' : 'tv';
        let displayName = show.name;
        let imageSrc = show.fallbackImage;
        
        // Fetch accurate dynamic backdrop if TMDB details are available
        try {
            const data = await fetchFromTMDB(`/${tmdbType}/${show.id}`);
            if (data) {
                displayName = data.title || data.name || show.name;
                if (data.backdrop_path) {
                    imageSrc = `${IMAGE_BASE_URL}/w300${data.backdrop_path}`;
                }
            }
        } catch (e) {
            console.warn('Failed to fetch details for continue watching item:', e);
        }
        
        const card = document.createElement('div');
        card.className = 'bg-cardBg hover:bg-cardBgHover border border-white/5 rounded-xl overflow-hidden flex items-center p-3 transition-all duration-300 hover:border-brand/40 group cursor-pointer shadow-md transform hover:-translate-y-1 active:scale-[0.99] min-w-0 flex-shrink-0';
        
        // Use the gray SVG fallback if imageSrc is empty or likely to fail
        const safeImageSrc = imageSrc && imageSrc.includes(IMAGE_BASE_URL) ? imageSrc : FALLBACK_BACKDROP;
        
        card.innerHTML = `
            <!-- Thumbnail -->
            <div class="w-24 h-16 rounded-lg overflow-hidden flex-shrink-0 relative bg-zinc-900">
                <img src="${safeImageSrc}" alt="${displayName}" 
                     class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                     onerror="this.onerror=null; this.src='${FALLBACK_BACKDROP}';">
                <div class="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                    <i class="fa-solid fa-play text-white text-base"></i>
                </div>
            </div>
            
            <!-- Metadata & Progress -->
            <div class="ml-4 flex-grow min-w-0">
                <div class="flex justify-between items-start">
                    <div class="min-w-0 flex-1">
                        <h4 class="font-bold text-sm text-white line-clamp-1 group-hover:text-brand transition-colors duration-200 truncate">${displayName}</h4>
                        <p class="text-xs text-textSec font-medium mt-0.5 truncate">${show.episode}</p>
                    </div>
                    <span class="text-xs font-bold text-brand bg-brand/10 px-1.5 py-0.5 rounded flex-shrink-0 ml-2">${show.progress}%</span>
                </div>
                
                <!-- Progress Bar -->
                <div class="w-full h-1.5 bg-white/10 rounded-full mt-3.5 overflow-hidden">
                    <div class="h-full progress-bar-gradient rounded-full" style="width: ${show.progress}%"></div>
                </div>
            </div>
        `;
        
        card.addEventListener('click', () => {
            if (show.episode === 'Filme Completo') {
                playMedia(show.id, 'movie', displayName, 1, 1);
            } else {
                const match = show.episode.match(/S(\d+):E(\d+)/);
                const season = match ? parseInt(match[1]) : 1;
                const episode = match ? parseInt(match[2]) : 1;
                playMedia(show.id, 'tv', displayName, season, episode);
            }
        });
        
        container.appendChild(card);
    }
    } finally {
        // Sempre liberar o lock, mesmo se houver erro
        isContinueWatchingInitializing = false;
    }
}

// Update or push to "Continue Assistindo" when media is played
async function updateContinueWatching(tmdbId, type, title, season = 1, episode = 1) {
    const user = JSON.parse(localStorage.getItem('brflix-user'));
    if (!user) return;
    
    const storageKey = `brflix-continue-watching-${user.email}`;
    let list = JSON.parse(localStorage.getItem(storageKey)) || [];
    
    // If empty list, load defaults first
    if (list.length === 0) {
        list = [...CONTINUE_WATCHING_DATA];
    }
    
    // Find if it exists
    const index = list.findIndex(item => item.id === tmdbId);
    let existingProgress = Math.floor(Math.random() * 40) + 15; // Random start progress between 15% and 55%
    if (index > -1) {
        existingProgress = list[index].progress || existingProgress;
        // Increment progress slightly on repeat views or next episodes
        existingProgress = Math.min(95, existingProgress + 5);
        list.splice(index, 1);
    }
    
    // Fetch backdrop path from TMDB
    let backdropPath = '';
    try {
        const details = await fetchFromTMDB(`/${type}/${tmdbId}`);
        if (details && details.backdrop_path) {
            backdropPath = `${IMAGE_BASE_URL}/w300${details.backdrop_path}`;
        }
    } catch (e) {
        console.warn('Failed to fetch details for background:', e);
    }
    
    const newItem = {
        id: tmdbId,
        name: title,
        episode: type === 'tv' ? `S${season}:E${episode}` : 'Filme Completo',
        progress: existingProgress,
        fallbackImage: backdropPath || `${UNSPLASH_PROXY_BASE}/photo-1543536448-d209d2d13a1c?q=80&w=300`,
        timestamp: Date.now()
    };
    
    list.unshift(newItem);
    
    // Keep max 5 items
    if (list.length > 5) {
        list = list.slice(0, 5);
    }
    
    localStorage.setItem(storageKey, JSON.stringify(list));
    
    // Update UI
    initContinueWatching();
}

// 4. Initialize "Filmes Nacionais Populares" (Right column)
async function initPopularMovies() {
    const container = document.getElementById('movies-carousel');
    container.innerHTML = '';
    
    // Step A: Load the requested 5 Brazilian classics first (to guarantee presence and order)
    const featuredClassicMovies = [];
    for (const id of BRAZILIAN_FEATURED_MOVIES_IDS) {
        const data = await fetchFromTMDB(`/movie/${id}`);
        if (data) featuredClassicMovies.push(data);
    }
    
    // Step B: Discover other popular Brazilian movies to enrich the row
    const discoverData = await fetchFromTMDB('/discover/movie', {
        'sort_by': 'popularity.desc',
        'page': '1',
        'vote_count.gte': MIN_DISCOVER_VOTE_COUNT,
        'without_keywords': BLOCKED_ADULT_KEYWORD_IDS
    });
    
    let combinedMovies = [...featuredClassicMovies];
    if (discoverData && discoverData.results) {
        // Prevent duplicate entries of our featured movies, and strip out any explicit content
        const discoverFiltered = discoverData.results.filter(
            m => !BRAZILIAN_FEATURED_MOVIES_IDS.includes(m.id) && !isExplicitContent(m)
        );
        combinedMovies = [...combinedMovies, ...discoverFiltered];
    }
    
    // Render movies in carousel (interleaved with native sponsored movie cards)
    combinedMovies.forEach((movie, idx) => {
        if (idx > 0 && idx % 5 === 0) {
            container.appendChild(createSponsoredPosterCard(Math.floor(idx / 5), 'sm'));
        }
        const card = createPosterCard(movie, 'movie');
        container.appendChild(card);
    });
}

// 5. Initialize "Séries em Alta" (Bottom row - 16:9 backdrop view)
async function initTrendingSeries() {
    const container = document.getElementById('series-carousel');
    container.innerHTML = '';
    
    // Load requested series by ID
    const featuredSeries = [];
    for (const id of BRAZILIAN_FEATURED_SERIES_IDS) {
        const data = await fetchFromTMDB(`/tv/${id}`);
        if (data) featuredSeries.push(data);
    }

    // Discover other popular TV series
    const discoverData = await fetchFromTMDB('/discover/tv', {
        'sort_by': 'popularity.desc',
        'vote_count.gte': MIN_DISCOVER_VOTE_COUNT,
        'without_keywords': BLOCKED_ADULT_KEYWORD_IDS
    });

    let combinedSeries = [...featuredSeries];
    if (discoverData && discoverData.results) {
        const discoverFiltered = discoverData.results.filter(
            s => !BRAZILIAN_FEATURED_SERIES_IDS.includes(s.id) && !isExplicitContent(s)
        );
        combinedSeries = [...combinedSeries, ...discoverFiltered];
    }

    // Render series as wide landscape cards (interleaved with native sponsored cards)
    combinedSeries.forEach((show, idx) => {
        if (idx > 0 && idx % 5 === 0) {
            container.appendChild(createSponsoredPosterCard(Math.floor(idx / 5), 'sm', true));
        }
        const card = createWideCard(show, 'tv');
        container.appendChild(card);
    });
}

// 6. Initialize "Animes em Alta" (Bottom row - 16:9 backdrop view)
async function initTrendingAnimesHome() {
    const container = document.getElementById('animes-home-carousel');
    if (!container) return;
    container.innerHTML = '';
    
    // Discover popular Japanese Anime (Genre: 16 - Animation, Keyword or language 'ja')
    try {
        const discoverData = await fetchFromTMDB('/discover/tv', {
            'with_genres': '16',
            'with_original_language': 'ja',
            'sort_by': 'popularity.desc',
            'page': '1',
            'vote_count.gte': MIN_DISCOVER_VOTE_COUNT,
            'without_keywords': BLOCKED_ADULT_KEYWORD_IDS
        });
        
        if (discoverData && discoverData.results) {
            // Take top 10 popular anime series, excluding any explicit content
            const animeList = discoverData.results.filter(show => !isExplicitContent(show)).slice(0, 10);
            animeList.forEach((show, idx) => {
                if (idx > 0 && idx % 5 === 0) {
                    container.appendChild(createSponsoredPosterCard(Math.floor(idx / 5), 'sm', true));
                }
                const card = createWideCard(show, 'tv');
                container.appendChild(card);
            });
        }
    } catch (e) {
        console.error('Failed to load home anime list:', e);
    }
}

// Renders a Top 10 row from an already-fetched/cached list (used by the
// Filmes/Séries/Animes tabs, which share their catalog cache with the filter grids).
function renderTop10Row(containerId, list, type, label) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    list.slice(0, 10).forEach((item, index) => {
        container.appendChild(createTop10Card(item, type, index + 1, label));
    });
}

function renderTop10Filmes() {
    const sorted = [...cachedFilmes].sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    renderTop10Row('top10-filmes-carousel', sorted, 'movie', 'Filme');
}

function renderTop10Series() {
    const sorted = [...cachedSeries].sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    renderTop10Row('top10-series-carousel', sorted, 'tv', 'Série');
}

function renderTop10Animes() {
    const sorted = [...cachedAnimes].sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    renderTop10Row('top10-animes-carousel', sorted, 'tv', 'Anime');
}

/**
 * COMPONENT RENDERING HELPERS
 */

// Generate 2:3 vertical poster card
function createPosterCard(item, type, size = 'sm') {
    const card = document.createElement('div');
    const isLarge = size === 'lg';
    card.className = isLarge
        ? 'w-full flex flex-col space-y-2 movie-card bg-cardBg rounded-xl overflow-hidden cursor-pointer select-none group'
        : 'w-[140px] sm:w-[170px] flex-shrink-0 flex flex-col space-y-2 movie-card bg-cardBg rounded-xl overflow-hidden cursor-pointer select-none group';
    
    const posterSrc = item.poster_path ? `${IMAGE_BASE_URL}/${isLarge ? 'w500' : 'w300'}${item.poster_path}` : FALLBACK_POSTER;
    const title = item.title || item.name;
    const year = (item.release_date || item.first_air_date || '').split('-')[0] || 'N/A';
    const rating = item.vote_average ? item.vote_average.toFixed(1) : '0.0';
    const titleSizeClass = isLarge ? 'text-sm sm:text-base' : 'text-xs sm:text-sm';
    const metaSizeClass = isLarge ? 'text-xs sm:text-sm' : 'text-[10px] sm:text-xs';
    
    card.innerHTML = `
        <!-- Thumbnail Wrap -->
        <div class="relative w-full aspect-[2/3] overflow-hidden bg-zinc-900">
            <img src="${posterSrc}" alt="${title}" loading="lazy" class="w-full h-full object-cover">
            <!-- Glass Overlay on Hover -->
            <div class="absolute inset-0 bg-gradient-to-t from-black via-black/30 to-transparent opacity-0 hover:opacity-100 transition-opacity duration-300 flex items-end p-3">
                <button class="play-btn bg-brand text-white w-9 h-9 rounded-full flex items-center justify-center shadow-lg transform translate-y-4 hover:scale-105 active:scale-95 transition-all duration-300 opacity-0 group-hover:opacity-100 group-hover:translate-y-0" style="transition-delay: 0.1s">
                    <i class="fa-solid fa-play text-sm"></i>
                </button>
            </div>
        </div>
        <!-- Meta Details -->
        <div class="p-2 sm:p-3 flex flex-col justify-between flex-grow">
            <h4 class="font-bold ${titleSizeClass} text-white line-clamp-1 group-hover:text-brand transition-colors duration-200" title="${title}">${title}</h4>
            <div class="flex items-center justify-between ${metaSizeClass} text-textSec font-medium mt-1">
                <span>${year}</span>
                <span class="flex items-center text-rating">
                    <i class="fa-solid fa-star text-[8px] sm:text-[10px] mr-1"></i>${rating}
                </span>
            </div>
        </div>
    `;
    
    // Attach details modal click (except play button)
    card.addEventListener('click', (e) => {
        if (e.target.closest('.play-btn')) return;
        openDetailsModal(item.id, type, item);
    });
    
    // Play quick action
    const playBtn = card.querySelector('.play-btn');
    if (playBtn) {
        playBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            playMedia(item.id, type, title, 1, 1);
        });
    }
    
    return card;
}

// -----------------------------------------------------------------------------
// NATIVE SPONSORED MOVIE CARDS (disguised as movie cards in catalog/carousels)
// -----------------------------------------------------------------------------
const SPONSORED_ADS_LIST = [
    {
        title: 'Assista Lançamentos Premium',
        poster: '/img-proxy/tmdb/w1280/56v2KjBlU4XaOv9rVYEQypROD7P.jpg',
        year: '2026',
        rating: '9.9',
        tag: 'PATROCINADO ✨',
        url: 'https://www.effectivecpmnetwork.com/d7093d1cb08180a88180d34df877e2e3'
    },
    {
        title: 'Filme Exclusivo Sem Anúncios',
        poster: '/img-proxy/tmdb/w1280/2ssWTSVklAEc98frZUQhgtGHx7s.jpg',
        year: '2026',
        rating: '9.8',
        tag: 'DESTAQUE 🌟',
        url: 'https://www.effectivecpmnetwork.com/d7093d1cb08180a88180d34df877e2e3'
    },
    {
        title: 'Recomendação Especial',
        poster: '/img-proxy/tmdb/w1280/rqbCbjB19amtOtFQbb3K2lgm2zv.jpg',
        year: '2026',
        rating: '9.7',
        tag: 'PROMOÇÃO 🔥',
        url: 'https://www.effectivecpmnetwork.com/d7093d1cb08180a88180d34df877e2e3'
    }
];

function isUserPremium() {
    try {
        const currentUser = JSON.parse(localStorage.getItem('brflix-user') || 'null');
        if (!currentUser) {
            document.body.classList.remove('user-premium');
            return false;
        }
        const isPrem = !!(
            currentUser.is_premium || 
            currentUser.ad_free || 
            currentUser.subscription_status === 'active' || 
            (currentUser.plan_type && currentUser.plan_type !== 'free')
        );
        if (isPrem) {
            document.body.classList.add('user-premium');
        } else {
            document.body.classList.remove('user-premium');
        }
        return isPrem;
    } catch (e) {
        return false;
    }
}

function createSponsoredPosterCard(adIndex = 0, size = 'sm', isWide = false) {
    return document.createDocumentFragment();
}

// Automatically inject sponsored native cards into static HTML carousels across active views (EXCEPT Top 10)
function injectAdsIntoStaticCarousels() {
    if (isUserPremium()) return;
    const views = ['view-inicio', 'view-filmes', 'view-series', 'view-animes', 'view-explorar'];
    let globalAdCount = 0;
    const MAX_TOTAL_ADS_PER_VIEW = 6;

    views.forEach(viewId => {
        const viewEl = document.getElementById(viewId);
        if (!viewEl || viewEl.classList.contains('hidden')) return;

        // Find ONLY genuine horizontal scrollable movie carousels
        const carousels = viewEl.querySelectorAll('.overflow-x-auto');
        carousels.forEach((carousel) => {
            if (globalAdCount >= MAX_TOTAL_ADS_PER_VIEW) return;
            if (carousel.id && carousel.id.toLowerCase().includes('top10')) return; // STRICTLY EXCLUDE TOP 10!
            if (carousel.classList.contains('ad-injected-flag')) return;

            const cards = Array.from(carousel.children).filter(child => {
                if (!child || child.nodeType !== 1) return false;
                return child.classList.contains('movie-card') || child.classList.contains('wide-card') || (child.getAttribute('onclick') && child.getAttribute('onclick').includes('openDetailsModal'));
            });

            if (cards.length < 4) return;
            carousel.classList.add('ad-injected-flag');

            const isWideCarousel = cards.some(c => c.classList.contains('wide-card'));

            // Inject at most 1 sponsored card at position index 4 per carousel
            if (cards[4] && globalAdCount < MAX_TOTAL_ADS_PER_VIEW) {
                const adCard = createSponsoredPosterCard(globalAdCount, 'sm', isWideCarousel);
                carousel.insertBefore(adCard, cards[4]);
                globalAdCount++;
            }
        });
    });
}

// Generate 16:9 horizontal backdrop card
function createWideCard(item, type) {
    const card = document.createElement('div');
    card.className = 'w-[240px] sm:w-[320px] flex-shrink-0 flex flex-col space-y-2 wide-card bg-cardBg rounded-xl overflow-hidden cursor-pointer select-none group';
    
    const backdropSrc = item.backdrop_path ? `${IMAGE_BASE_URL}/w500${item.backdrop_path}` : FALLBACK_BACKDROP;
    const title = item.title || item.name;
    const year = (item.release_date || item.first_air_date || '').split('-')[0] || 'N/A';
    const rating = item.vote_average ? item.vote_average.toFixed(1) : '0.0';
    
    card.innerHTML = `
        <!-- Thumbnail Wrap -->
        <div class="relative w-full aspect-[16/9] overflow-hidden bg-zinc-900">
            <img src="${backdropSrc}" alt="${title}" loading="lazy" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500">
            
            <!-- Shadow Gradient Overlay -->
            <div class="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-transparent flex flex-col justify-end p-4">
                <!-- Play Button Overlay -->
                <div class="w-10 h-10 rounded-full bg-brand/90 text-white flex items-center justify-center shadow-lg opacity-0 group-hover:opacity-100 transform translate-y-2 group-hover:translate-y-0 transition-all duration-300 absolute top-4 right-4 hover:bg-brand-light">
                    <i class="fa-solid fa-play text-sm ml-0.5"></i>
                </div>
                
                <!-- Display typography inside card -->
                <h4 class="font-condensed font-bold text-xl sm:text-2xl text-white tracking-wide uppercase line-clamp-1 drop-shadow-md group-hover:text-brand transition-colors duration-200">${title}</h4>
                
                <!-- Metadata line -->
                <div class="flex items-center space-x-3 text-[10px] sm:text-xs text-textSec font-medium mt-1">
                    <span>${year}</span>
                    <span>•</span>
                    <span class="flex items-center text-rating">
                        <i class="fa-solid fa-star mr-1"></i>${rating}
                    </span>
                    <span>•</span>
                    <span class="px-1.5 py-0.2 bg-zinc-800/80 border border-white/10 rounded uppercase font-bold text-[8px] tracking-wider">${type === 'movie' ? 'Filme' : 'Série'}</span>
                </div>
            </div>
        </div>
    `;
    
    // Attach details modal click
    card.addEventListener('click', () => {
        openDetailsModal(item.id, type);
    });
    
    return card;
}

// Generate a "Top 10 hoje" ranked card: a giant outlined rank number sitting
// behind a compact poster, with a rating ring badge — same visual language
// used by major streaming platforms for their daily Top 10 rows.
function createTop10Card(item, type, rank, label) {
    const wrapper = document.createElement('article');
    wrapper.className = 'group/item relative flex items-end gap-0 pt-3 pb-4 flex-shrink-0 cursor-pointer select-none';

    // Same poster size/source as the regular carousels (createPosterCard 'sm'),
    // so the Top 10 row lines up visually with rows like "Filmes Premiados".
    const posterSrc = item.poster_path ? `${IMAGE_BASE_URL}/w300${item.poster_path}` : FALLBACK_POSTER;
    const title = item.title || item.name || 'Sem título';
    const rating = item.vote_average ? item.vote_average.toFixed(1) : '0.0';
    const digits = rank >= 10 ? '2' : '1';

    wrapper.innerHTML = `
        <div class="top10-rank-wrap shrink-0 flex items-end justify-end -mr-4 sm:-mr-5 relative z-20 pointer-events-none select-none overflow-visible">
            <span class="top10-rank font-black text-[60px] sm:text-[72px]" data-digits="${digits}">${rank}</span>
        </div>
        <div class="relative z-10 w-[140px] sm:w-[170px] flex-shrink-0 rounded-2xl overflow-hidden shadow-xl ring-1 ring-white/10 transition-all duration-300 group-hover/item:scale-[1.04] group-hover/item:shadow-2xl bg-cardBg">
            <div class="relative aspect-[2/3] overflow-hidden bg-zinc-900">
                <img src="${posterSrc}" alt="${title}" loading="lazy" class="w-full h-full object-cover">
                <div class="absolute top-2 right-2 flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-black/70 backdrop-blur-md border border-white/10 z-20 pointer-events-none">
                    <i class="fa-solid fa-star text-rating text-[9px]"></i>
                    <span class="text-[10px] font-bold text-white">${rating}</span>
                </div>
                <div class="absolute inset-x-0 bottom-0 p-2.5 bg-gradient-to-t from-black via-black/70 to-transparent text-white">
                    <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[9px] font-extrabold uppercase tracking-wider bg-white/15 border border-white/10 backdrop-blur-md mb-1.5">
                        ${label}
                    </span>
                    <h3 class="text-xs sm:text-sm font-extrabold line-clamp-1">${title}</h3>
                </div>
            </div>
        </div>
    `;

    wrapper.addEventListener('click', () => openDetailsModal(item.id, type));
    return wrapper;
}

/**
 * RELEASE CALENDAR NOTIFICATIONS
 * Cross-references the public release calendar (proxied server-side at
 * /calendario-cached, see superflixapi.run/calendario.php) against the
 * titles the user follows in "Minha Lista" (myPlaylist), and raises a real
 * notification whenever a followed show has a new episode airing today.
 * Replaces the old static/dummy notification dropdown content.
 */
const CALENDAR_SEEN_KEY = 'brflix-calendar-seen';
// Keys (tmdbId-season-number) for the notifications currently shown in the
// dropdown, so opening the bell or clicking "marcar como lidas" can persist
// them as seen without re-fetching the calendar.
let lastCalendarEntryKeys = [];

function getSeenCalendarKeys() {
    try {
        return new Set(JSON.parse(localStorage.getItem(CALENDAR_SEEN_KEY)) || []);
    } catch (e) {
        return new Set();
    }
}

function markCalendarKeysSeen(keys) {
    if (!keys || keys.length === 0) return;
    const seen = getSeenCalendarKeys();
    keys.forEach(k => seen.add(k));
    // Cap stored history so this doesn't grow unbounded over months of use.
    localStorage.setItem(CALENDAR_SEEN_KEY, JSON.stringify(Array.from(seen).slice(-200)));
    const badge = notificationBtn.querySelector('span');
    if (badge) badge.remove();
}

async function initCalendarNotifications() {
    const user = JSON.parse(localStorage.getItem('brflix-user'));
    if (!user) {
        renderCalendarNotifications([], false, 'Faça login para receber notificações dos títulos que você segue.');
        return;
    }
    if (!myPlaylist || myPlaylist.length === 0) {
        renderCalendarNotifications([], false, 'Adicione títulos à Minha Lista para ser avisado quando saírem novos episódios.');
        return;
    }

    try {
        const response = await fetch('/calendario-cached');
        if (!response.ok) return;
        const calendar = await response.json();
        if (!Array.isArray(calendar)) return;

        const followedIds = new Set(myPlaylist.map(p => String(p.id)));
        // Only entries airing "Hoje" are worth surfacing as a notification —
        // "Futuro" hasn't aired yet, and everything else is historical backlog.
        const relevant = calendar.filter(ep => followedIds.has(String(ep.tmdb_id)) && ep.status === 'Hoje');

        const seen = getSeenCalendarKeys();
        const hasUnread = relevant.some(ep => !seen.has(`${ep.tmdb_id}-${ep.season}-${ep.number}`));

        renderCalendarNotifications(relevant, hasUnread, 'Nenhuma novidade hoje dos títulos que você segue.');
    } catch (e) {
        console.error('Failed to load release calendar notifications:', e);
    }
}

function renderCalendarNotifications(entries, hasUnread, emptyMessage) {
    const list = document.getElementById('notification-list');
    if (!list) return;

    lastCalendarEntryKeys = entries.map(ep => `${ep.tmdb_id}-${ep.season}-${ep.number}`);

    if (entries.length === 0) {
        list.innerHTML = `<div class="p-6 text-center text-textSec text-xs">${emptyMessage}</div>`;
    } else {
        list.innerHTML = '';
        entries.slice(0, 15).forEach(ep => {
            const row = document.createElement('div');
            row.className = 'p-3 hover:bg-white/5 transition-colors duration-200 flex items-center gap-3 cursor-pointer';
            const posterSrc = ep.poster ? `${IMAGE_BASE_URL}/w92${ep.poster}` : FALLBACK_POSTER;
            row.innerHTML = `
                <img src="${posterSrc}" alt="${ep.title}" class="w-10 h-14 object-cover rounded-md flex-shrink-0 bg-zinc-900">
                <div class="flex-1 min-w-0">
                    <p class="text-white font-medium text-sm line-clamp-1">Novo episódio de "${ep.title}"!</p>
                    <p class="text-textSec text-xs line-clamp-1">T${ep.season}:E${ep.number} — ${ep.episode || ''}</p>
                    <span class="text-[10px] text-brand font-bold uppercase tracking-wide">Hoje</span>
                </div>
            `;
            row.addEventListener('click', () => {
                notificationDropdown.classList.add('hidden');
                openDetailsModal(parseInt(ep.tmdb_id), 'tv');
            });
            list.appendChild(row);
        });
    }

    const badge = notificationBtn.querySelector('span');
    if (hasUnread) {
        if (!badge) {
            const dot = document.createElement('span');
            dot.className = 'absolute -top-1 -right-1 w-2.5 h-2.5 bg-notify rounded-full animate-pulse';
            notificationBtn.appendChild(dot);
        }
    } else if (badge) {
        badge.remove();
    }
}

/**
 * INTERACTIVE DROPDOWNS & ACTIONS
 */

function initDropdowns() {
    // 1. Notifications Dropdown
    notificationBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasHidden = notificationDropdown.classList.contains('hidden');
        notificationDropdown.classList.toggle('hidden');
        profileDropdown.classList.add('hidden');
        searchDropdown.classList.add('hidden');
        // Opening the dropdown counts as "read" — persist so the badge doesn't
        // reappear for the same episodes on the next visit.
        if (wasHidden) markCalendarKeysSeen(lastCalendarEntryKeys);
    });

    if (clearNotifications) {
        clearNotifications.addEventListener('click', () => {
            markCalendarKeysSeen(lastCalendarEntryKeys);
            const list = document.getElementById('notification-list');
            list.innerHTML = `<div class="p-6 text-center text-textSec text-xs">Nenhuma notificação nova</div>`;
        });
    }

    // 2. Profile Dropdown
    profileDropdownBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        profileDropdown.classList.toggle('hidden');
        notificationDropdown.classList.add('hidden');
        searchDropdown.classList.add('hidden');
    });

    // 3. Mobile Hamburger Menu
    mobileMenuBtn.addEventListener('click', () => {
        mobileMenu.classList.add('menu-open');
    });

    closeMobileMenu.addEventListener('click', () => {
        mobileMenu.classList.remove('menu-open');
    });

    // Mobile nav links close menu
    document.querySelectorAll('.mobile-nav-link').forEach(link => {
        link.addEventListener('click', () => {
            mobileMenu.classList.remove('menu-open');
        });
    });

    // 3b. "Mais" tab (mobile bottom nav) opens the same side menu used by the
    // tablet hamburger button, so Animes/Minha Lista/Configurações stay reachable.
    const bottomNavMaisBtn = document.getElementById('bottomnav-mais');
    if (bottomNavMaisBtn) {
        bottomNavMaisBtn.addEventListener('click', () => {
            mobileMenu.classList.add('menu-open');
        });
    }

    // Close dropdowns when clicking outside
    document.addEventListener('click', () => {
        notificationDropdown.classList.add('hidden');
        profileDropdown.classList.add('hidden');
        searchDropdown.classList.add('hidden');
    });

    // Prevent propagation inside dropdown boxes
    notificationDropdown.addEventListener('click', (e) => e.stopPropagation());
    profileDropdown.addEventListener('click', (e) => e.stopPropagation());
    
    // 4. Immersive Mode VR (Sepia/Color filters easter-egg)
    vrBtn.addEventListener('click', () => {
        document.body.classList.toggle('vr-mode');
        vrBtn.classList.toggle('text-brand');
        vrBtn.classList.toggle('text-textSec');
        
        // Pulse animation overlay notification toast
        showToast(document.body.classList.contains('vr-mode') ? "Modo Imersivo VR Ativado!" : "Modo VR Desativado.");
    });
}

// Custom simple toast helper
function showToast(message) {
    let toast = document.getElementById('brflix-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'brflix-toast';
        // Sleek compact toast pill with max-width and clean padding
        toast.className = 'fixed bottom-20 md:bottom-6 left-1/2 transform -translate-x-1/2 z-[100] bg-bgSec/95 border border-white/15 backdrop-blur-md text-white text-xs font-semibold px-4 py-2.5 rounded-full shadow-2xl pointer-events-none transition-all duration-300 translate-y-8 opacity-0 flex items-center space-x-2 max-w-[90vw] sm:max-w-md';
        document.body.appendChild(toast);
    }
    
    toast.innerHTML = `<i class="fa-solid fa-circle-info text-brand text-xs"></i><span class="truncate">${escapeHtml(message)}</span>`;
    toast.classList.remove('translate-y-8', 'opacity-0');
    toast.classList.add('translate-y-0', 'opacity-100');
    
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => {
        toast.classList.remove('translate-y-0', 'opacity-100');
        toast.classList.add('translate-y-8', 'opacity-0');
    }, 2500);
}

/**
 * ADBLOCK DETECTION
 */

// Drops an invisible "bait" element using class names commonly targeted by
// AdBlock filter lists (EasyList etc). Catches blockers that hide elements via
// injected CSS rules (cosmetic filtering) rather than blocking network requests.
function detectAdBlockViaBait() {
    return new Promise((resolve) => {
        const bait = document.createElement('div');
        bait.className = 'adsbox ad-banner ad-placement pub_300x250 textads adsbygoogle';
        bait.setAttribute('aria-hidden', 'true');
        Object.assign(bait.style, {
            position: 'absolute',
            top: '-9999px',
            left: '-9999px',
            width: '1px',
            height: '1px',
        });
        document.body.appendChild(bait);

        setTimeout(() => {
            const style = getComputedStyle(bait);
            const blocked = !document.body.contains(bait)
                || bait.offsetParent === null
                || bait.offsetHeight === 0
                || style.display === 'none'
                || style.visibility === 'hidden';
            bait.remove();
            resolve(blocked);
        }, 150);
    });
}

// Most modern blockers (uBlock Origin, AdBlock Plus, Brave Shields) act at the
// network layer, but crucially DO NOT always reject the request. Brave (and
// uBlock, which shares the same engine) frequently redirect known ad/tracker
// URLs to a small local "surrogate" script instead of just cancelling them —
// confirmed by inspecting a HAR capture of this exact page: adsbygoogle.js
// and gpt.js both came back as `200 OK` with valid (fake) JS content that
// defines window.adsbygoogle/window.googletag as harmless no-ops, so the
// page never notices anything failed. A fetch() rejection/onerror check
// CANNOT catch this — nothing errors, nothing rejects, it's a normal success.
//
// What DOES give it away: timing. The HAR showed these "successful" surrogate
// responses resolving in ~2ms flat, with dns/connect/ssl all reported as -1 —
// i.e. the request never actually left the machine. A real network round trip
// to a Google-operated ad domain (DNS + TCP + TLS handshake) cannot complete
// that fast. So instead of asking "did this fail?", we ask "did this resolve
// suspiciously instantly?".
const SURROGATE_RESPONSE_THRESHOLD_MS = 40;

function detectAdBlockViaNetwork() {
    const probeUrls = [
        'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js',
        'https://www.googletagservices.com/tag/js/gpt.js',
        'https://securepubads.g.doubleclick.net/tag/js/gpt.js',
    ];

    // A slow/offline network could otherwise leave a legitimate request hanging
    // for a while — a 4s timeout per probe treats "still pending" as "not blocked"
    // (an outright cancellation would reject almost instantly instead) rather than
    // stalling detectAdBlock() indefinitely.
    const probe = (url) => {
        // Cache-busting query param: forces a real network round trip even if this
        // exact URL was previously fetched (and cached) unblocked, so the timing
        // comparison below can't be skewed by a legitimate HTTP cache hit.
        const bustedUrl = `${url}?_=${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const startedAt = performance.now();
        const timeout = new Promise((resolve) => setTimeout(() => resolve(false), 4000));
        const attempt = fetch(bustedUrl, { method: 'GET', mode: 'no-cors', cache: 'no-store' })
            .then(() => (performance.now() - startedAt) < SURROGATE_RESPONSE_THRESHOLD_MS) // suspiciously instant -> local surrogate
            .catch(() => true); // rejected outright -> blocked by client (extensions using webRequest cancellation)
        return Promise.race([attempt, timeout]);
    };

    // Any single blocked probe is enough to conclude a blocker is active.
    return Promise.all(probeUrls.map(probe)).then((results) => results.some(Boolean));
}

// Loads a real <script> tag pointing at a known, universally-filtered ad
// domain, as a second, independent probe alongside detectAdBlockViaNetwork.
// A cancelled (not surrogate-redirected) request for a <script src> still
// reliably fires that element's 'error' event, which is how this used to
// work for extensions that do a hard cancel. But same as above, Brave's
// surrogate redirection makes the script "load" successfully (onload fires)
// — so this also needs the timing check to catch that case, not just onerror.
function detectAdBlockViaScriptTag() {
    return new Promise((resolve) => {
        const script = document.createElement('script');
        const startedAt = performance.now();
        let settled = false;

        const finish = (blocked) => {
            if (settled) return;
            settled = true;
            clearTimeout(safetyTimer);
            script.remove();
            resolve(blocked);
        };

        // Same cache-busting reasoning as detectAdBlockViaNetwork above.
        script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?_=${Date.now()}-${Math.random().toString(36).slice(2)}`;
        script.async = true;
        // A real Google ad script involves a genuine DNS+TLS round trip and is tens
        // of KB — it cannot legitimately finish loading in a couple of milliseconds.
        script.onload = () => finish((performance.now() - startedAt) < SURROGATE_RESPONSE_THRESHOLD_MS);
        script.onerror = () => finish(true);

        // Safety net: on the rare chance neither event fires (e.g. a blocker
        // that silently stalls the request instead of failing it outright),
        // treat "still not loaded" after a generous window as blocked too —
        // a real ad script from Google normally loads almost instantly.
        const safetyTimer = setTimeout(() => finish(true), 3000);

        document.head.appendChild(script);
    });
}

function detectAdBlock() {
    return Promise.all([
        detectAdBlockViaBait(),
        detectAdBlockViaNetwork(),
        detectAdBlockViaScriptTag(),
    ]).then(([baitBlocked, networkBlocked, scriptBlocked]) => {
        const blocked = baitBlocked || networkBlocked || scriptBlocked;
        lastKnownAdBlockStatus = blocked; // cached for the presence heartbeat, see startPresenceHeartbeat()
        return blocked;
    });
}

// Heartbeat-based presence for the admin dashboard (see server/presence.js):
// every ~20s, tell the server whether this session is alive and whether the
// user is currently watching something. Deliberately polling, not a
// WebSocket — simpler to run/scale for this site's traffic level and the
// existing Postgres-only backend.
const PRESENCE_HEARTBEAT_INTERVAL_MS = 20000;
const VISITOR_ID_KEY = 'brflix-visitor-id';

/**
 * A random, disposable ID for logged-out visitors so the admin dashboard's
 * "online now" / "watching now" can count them too (previously only
 * logged-in sessions were counted — see server/presence.js). It carries no
 * account/personal data, is generated client-side, and persists only in
 * this browser's localStorage (cleared like any other site data).
 */
function getVisitorId() {
    let id = localStorage.getItem(VISITOR_ID_KEY);
    if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem(VISITOR_ID_KEY, id);
    }
    return id;
}

function startPresenceHeartbeat() {
    const ping = () => {
        const payload = { isWatching: isPlayerWatching, adBlockDetected: lastKnownAdBlockStatus };
        // Logged-in and logged-out visitors report to two different routes
        // (see server/presence.js for why) but the dashboard adds both
        // together, so every open tab — authenticated or not — is counted.
        const request = getAuthToken()
            ? apiFetch('/api/presence/heartbeat', { method: 'POST', body: JSON.stringify(payload) })
            : apiFetch('/api/presence/heartbeat-anon', { method: 'POST', body: JSON.stringify({ ...payload, visitorId: getVisitorId() }) });
        request.catch((err) => console.warn('[Presence] Heartbeat failed:', err.message));
    };
    ping();
    setInterval(ping, PRESENCE_HEARTBEAT_INTERVAL_MS);
}

const ADBLOCK_SNOOZE_KEY = 'brflix-adblock-snooze-until';

function isAdBlockNoticeSnoozed() {
    const until = parseInt(localStorage.getItem(ADBLOCK_SNOOZE_KEY) || '0', 10);
    return Date.now() < until;
}

// Dismissing the notice (X, "Continuar assim mesmo", or clicking the backdrop)
// snoozes it for 24h so it doesn't nag on every single page reload.
function snoozeAdBlockNotice(hours = 24) {
    localStorage.setItem(ADBLOCK_SNOOZE_KEY, (Date.now() + hours * 60 * 60 * 1000).toString());
}

function initAdBlockDetector() {
    const modal = document.getElementById('adblock-modal');
    if (!modal) return;

    const closeBtn = document.getElementById('adblock-modal-close');
    const dismissBtn = document.getElementById('adblock-modal-dismiss');
    const recheckBtn = document.getElementById('adblock-modal-recheck');

    const dismiss = () => {
        snoozeAdBlockNotice();
        modal.classList.add('hidden');
    };

    if (closeBtn) closeBtn.addEventListener('click', dismiss);
    if (dismissBtn) dismissBtn.addEventListener('click', dismiss);
    modal.addEventListener('click', (e) => { if (e.target === modal) dismiss(); });

    if (recheckBtn) {
        const originalLabel = recheckBtn.textContent;
        recheckBtn.addEventListener('click', async () => {
            recheckBtn.disabled = true;
            recheckBtn.innerHTML = '<i class="fa-solid fa-spinner animate-spin"></i>';
            const stillBlocked = await detectAdBlock();
            recheckBtn.disabled = false;
            recheckBtn.textContent = originalLabel;
            if (stillBlocked) {
                showToast('Ainda detectamos um AdBlock ativo 🙁');
            } else {
                localStorage.removeItem(ADBLOCK_SNOOZE_KEY);
                modal.classList.add('hidden');
                showToast('Obrigado por apoiar o BRFLIX! 💙');
            }
        });
    }

    // Ad-free accounts don't depend on ad revenue from their own session, and
    // a recently-dismissed notice shouldn't reappear immediately.
    if (isUserPremium()) return;
    detectAdBlock().then((blocked) => {
        if (blocked) modal.classList.remove('hidden');
    });
}

function initDiscordDailyModal() {
    const modal = document.getElementById('discord-daily-modal');
    if (!modal) return;

    const closeBtn = document.getElementById('discord-modal-close');
    const dismissBtn = document.getElementById('discord-modal-dismiss-btn');
    const joinBtn = document.getElementById('discord-modal-join-btn');

    const todayStr = new Date().toISOString().slice(0, 10);
    const lastPromptDate = localStorage.getItem('brflix_discord_modal_date');

    const markSeenAndClose = () => {
        localStorage.setItem('brflix_discord_modal_date', todayStr);
        modal.classList.add('hidden');
    };

    if (closeBtn) closeBtn.addEventListener('click', markSeenAndClose);
    if (dismissBtn) dismissBtn.addEventListener('click', markSeenAndClose);
    if (joinBtn) joinBtn.addEventListener('click', markSeenAndClose);
    modal.addEventListener('click', (e) => { if (e.target === modal) markSeenAndClose(); });

    // Show on the first visit of the day after a 3.5s delay
    if (lastPromptDate !== todayStr) {
        setTimeout(() => {
            if (typeof isPlayerActive === 'function' && isPlayerActive()) return;
            modal.classList.remove('hidden');
        }, 3500);
    }
}

/**
 * MONETIZATION: Adsterra ad slots
 *
 * Deliberately restricted to Native Banner + static Display Banner formats
 * only — no Social Bar, Popunder, Interstitial or Push. Those formats are
 * Adsterra's highest-CPM inventory precisely because they're disruptive
 * (redirect on click anywhere on the page, browser permission prompts,
 * etc.), which conflicts with the site's goal of staying unobtrusive.
 *
 * Two different Adsterra ad codes are involved here, and they're rendered
 * very differently on purpose:
 *
 * - Native Banner (effectivecpmnetwork.com): async script that looks for a
 *   div with a fixed id ("container-<key>") on the page. That id can only
 *   exist ONCE in a valid DOM, so this format is placed in a single spot
 *   (the footer) rather than repeated across every slot.
 * - Display Banner (highperformanceformat.com, 'iframe' format): this is
 *   Adsterra's classic ad tag, which calls document.write() internally.
 *
 * BOTH formats are rendered via renderAdFrame(), which points an iframe at
 * our own same-origin /ad-frame route (server/app-middleware.js) instead of
 * injecting the ad script directly into the main document. Two reasons:
 *   1. document.write() called via createElement/append (i.e. after the page
 *      already finished loading) makes the browser wipe the ENTIRE page and
 *      start a new document — /ad-frame's own separate HTML response avoids
 *      that entirely.
 *   2. Adsterra creatives are ultimately served through a constantly-
 *      rotating pool of unrelated-looking domains (confirmed in production:
 *      realizationnewestfangs.com, exemplarfederallithe.com, etc.) — domains
 *      that cannot be pinned in advance in a CSP allowlist. Isolating them
 *      inside /ad-frame's own relaxed CSP means the MAIN site's CSP (which is
 *      what actually protects against XSS) never has to be loosened for ads.
 *   See the AD_FRAME_ORIGIN comment below for why the iframe's `sandbox`
 *   attribute includes `allow-same-origin` despite that risk being exactly
 *   what sandboxing normally guards against.
 */
const AD_NATIVE_KEY = 'f33bfc2110232e114aa84edd1f4c9f98';

const AD_BANNER_300x250 = { key: '822e36ee0f0bef885ccdd44d99987fd1', width: 300, height: 250 };
const AD_BANNER_728x90 = { key: 'eb92c9dfaf040950cd51a1083ea4f479', width: 728, height: 90 };

const AD_SLOTS = [
    { wrapperId: 'ad-slot-filmes-wrapper', containerId: 'ad-slot-filmes', type: 'banner', banner: AD_BANNER_300x250 },
    { wrapperId: 'ad-slot-series-wrapper', containerId: 'ad-slot-series', type: 'banner', banner: AD_BANNER_300x250 },
    { wrapperId: 'ad-slot-animes-wrapper', containerId: 'ad-slot-animes', type: 'banner', banner: AD_BANNER_728x90 },
    { wrapperId: 'ad-slot-footer-wrapper', containerId: 'ad-slot-footer', type: 'native' },
];

/**
 * Renders an Adsterra ad unit inside a dedicated /ad-frame document served
 * from its own subdomain (see app-middleware.js for the route). Ad networks
 * route creatives through a constantly-rotating pool of domains that can't
 * be pinned in a CSP allowlist, so the ad markup lives in its own isolated
 * HTML document (own headers, own relaxed CSP) instead of loosening the
 * main site's CSP.
 *
 * AD_FRAME_ORIGIN is a genuinely separate origin (ads.brflix.lat, not just a
 * same-origin path) specifically so `allow-same-origin` can be included in
 * `sandbox` below. Adsterra's script reads/writes document.cookie internally
 * (UUID sync) and throws an uncaught SecurityError without that flag, which
 * halted the whole script before it ever rendered a creative. Granting
 * allow-same-origin is safe here ONLY because it's a different origin from
 * the main site — the browser's own storage partitioning means the ad
 * script's document.cookie / localStorage is isolated from brflix.lat's,
 * so it still can never read this site's auth token. `allow-popups(
 * -to-escape-sandbox)` is kept because Adsterra creatives are click-through
 * ads that open their landing page in a new tab.
 *
 * Falls back to the same-origin relative path in local dev (localhost has
 * no ads.* subdomain, and ad creatives aren't expected to render there).
 */
const AD_FRAME_ORIGIN = '';

function renderAdFrame(container, { type, key, width, height }) {
    const iframe = document.createElement('iframe');
    if (width) iframe.width = String(width);
    if (height) iframe.height = String(height);
    iframe.style.border = '0';
    iframe.style.display = 'block';
    iframe.scrolling = 'no';
    iframe.title = 'Publicidade';
    iframe.loading = 'lazy';

    const params = new URLSearchParams({ type, key });
    if (width) params.set('w', String(width));
    if (height) params.set('h', String(height));
    iframe.src = `/ad-frame?${params.toString()}`;

    container.appendChild(iframe);
}

/** Renders an Adsterra static Display Banner (see renderAdFrame above for why an iframe route is used). */
function renderAdsterraBanner(container, { key, width, height }) {
    renderAdFrame(container, { type: 'banner', key, width, height });
}

/** Renders the Adsterra Native Banner (single global instance, see renderAdFrame above for why an iframe route is used). */
function renderAdsterraNative(container) {
    renderAdFrame(container, { type: 'native', key: AD_NATIVE_KEY, width: '100%', height: 300 });
}

function initAds() {
    // AdCash disabled; Monetag scripts loaded globally in index.html
}

/**
 * DYNAMIC DEBOUNCED SEARCH (TMDB API)
 */

// Guards against out-of-order network responses: if the user keeps typing,
// an older/slower request's response must never overwrite the results of a
// newer one (e.g. a slow response for "Stranger" landing after a faster one
// for "Stranger Things", showing an unrelated title in the dropdown).
let searchRequestId = 0;

function initSearch() {
    let debounceTimeout = null;

    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.trim();
        clearTimeout(debounceTimeout);

        if (!query) {
            searchDropdown.classList.add('hidden');
            return;
        }

        // Debounce fetch calls by 400ms to respect API rate limits
        debounceTimeout = setTimeout(async () => {
            const requestId = ++searchRequestId;
            const results = await performSearch(query);
            if (requestId !== searchRequestId) return; // a newer query started meanwhile — discard
            renderSearchResults(results);
        }, 400);
    });

    // Focus displays dropdown if populated
    searchInput.addEventListener('focus', () => {
        if (searchInput.value.trim() && searchDropdown.children.length > 0) {
            searchDropdown.classList.remove('hidden');
            notificationDropdown.classList.add('hidden');
            profileDropdown.classList.add('hidden');
        }
    });

    // Avoid search blur hiding click handler
    searchDropdown.addEventListener('mousedown', (e) => {
        e.preventDefault(); // Prevents input focusout from firing immediately before click registers
    });
}

async function performSearch(query) {
    const data = await fetchFromTMDB('/search/multi', { query: query, include_adult: 'false' });
    if (data && data.results) {
        // Filter elements only to movies and TV series, and strip out adult content
        const filtered = data.results.filter(item => {
            if (item.media_type !== 'movie' && item.media_type !== 'tv') return false;
            if (isExplicitContent(item)) return false;
            // Descartar documentarios/especiais de baixissima popularidade
            if (item.popularity < 1.0 && item.vote_count < 2) return false;
            return true;
        });

        // Ordenação inteligente: match exato de título no topo, depois popularidade descrescente
        const queryLower = query.toLowerCase().trim();
        filtered.sort((a, b) => {
            const titleA = (a.title || a.name || '').toLowerCase().trim();
            const titleB = (b.title || b.name || '').toLowerCase().trim();
            
            const matchA = titleA === queryLower;
            const matchB = titleB === queryLower;

            if (matchA && !matchB) return -1;
            if (!matchA && matchB) return 1;

            return (b.popularity || 0) - (a.popularity || 0);
        });

        return filtered.slice(0, 7);
    }
    return [];
}

function renderSearchResults(results) {
    searchDropdown.innerHTML = '';
    
    if (results.length === 0) {
        searchDropdown.innerHTML = `<div class="p-4 text-center text-textSec text-xs">Nenhum resultado encontrado</div>`;
        searchDropdown.classList.remove('hidden');
        return;
    }
    
    results.forEach(item => {
        const title = item.title || item.name;
        const year = (item.release_date || item.first_air_date || '').split('-')[0] || 'N/A';
        const rating = item.vote_average ? item.vote_average.toFixed(1) : '0.0';
        const posterSrc = item.poster_path ? `${IMAGE_BASE_URL}/w92${item.poster_path}` : FALLBACK_POSTER;
        const typeText = item.media_type === 'movie' ? 'Filme' : 'Série';

        const row = document.createElement('div');
        row.className = 'flex items-center p-3 hover:bg-white/5 border-b border-white/5 cursor-pointer transition-colors duration-150';
        row.innerHTML = `
            <img src="${posterSrc}" alt="${title}" class="w-10 h-14 object-cover rounded-md flex-shrink-0">
            <div class="ml-3 flex-grow min-w-0">
                <h5 class="text-sm font-bold text-white line-clamp-1">${title}</h5>
                <p class="text-xs text-textSec mt-0.5">${typeText} • ${year} • <i class="fa-solid fa-star text-rating text-[9px] mr-0.5"></i> ${rating}</p>
            </div>
            <i class="fa-solid fa-chevron-right text-textSec text-xs pr-2"></i>
        `;

        row.addEventListener('click', () => {
            searchInput.value = '';
            searchDropdown.classList.add('hidden');
            openDetailsModal(item.id, item.media_type);
        });

        searchDropdown.appendChild(row);
    });

    searchDropdown.classList.remove('hidden');
}

/**
 * CAROUSEL H-SCROLL NAVIGATION
 */

function initSliders() {
    setupSlider(moviesCarousel, 'slide-left-movies', 'slide-right-movies');
    setupSlider(seriesCarousel, 'slide-left-series', 'slide-right-series');
    setupSlider(animesHomeCarousel, 'slide-left-animes-home', 'slide-right-animes-home');
}

function setupSlider(carousel, leftBtnId, rightBtnId) {
    const leftBtn = document.getElementById(leftBtnId);
    const rightBtn = document.getElementById(rightBtnId);
    
    if (!leftBtn || !rightBtn || !carousel) return;
    
    leftBtn.addEventListener('click', () => {
        carousel.scrollBy({ left: -320, behavior: 'smooth' });
    });
    
    rightBtn.addEventListener('click', () => {
        carousel.scrollBy({ left: 320, behavior: 'smooth' });
    });
    
    // Hide controls if contents fits completely (optional improvement)
    const checkScrollBounds = () => {
        if (carousel.scrollLeft <= 5) {
            leftBtn.classList.add('opacity-40');
        } else {
            leftBtn.classList.remove('opacity-40');
        }

        if (carousel.scrollLeft + carousel.clientWidth >= carousel.scrollWidth - 5) {
            rightBtn.classList.add('opacity-40');
        } else {
            rightBtn.classList.remove('opacity-40');
        }
    };

    carousel.addEventListener('scroll', checkScrollBounds);
    window.addEventListener('resize', checkScrollBounds);
    setTimeout(checkScrollBounds, 1000); // Wait for contents rendering
}

/**
 * DETAILS MODAL MANAGEMENT
 */

function slugify(text) {
    if (!text) return '';
    return text.toString().toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // remove accents
        .replace(/\s+/g, '-')           // Replace spaces with -
        .replace(/[^\w\-]+/g, '')       // Remove all non-word chars
        .replace(/\-\-+/g, '-')         // Replace multiple - with single -
        .replace(/^-+/, '')             // Trim - from start
        .replace(/-+$/, '');            // Trim - from end
}

async function openDetailsModal(id, type, initialItem = null) {
    currentOpenItem = { id, type };
    
    // Set UI Loading / Optimistic State
    const initTitle = initialItem ? (initialItem.title || initialItem.name) : "Carregando...";
    const initOverview = initialItem ? (initialItem.overview || "Buscando informações oficiais de produção...") : "Buscando informações oficiais de produção...";
    const initYear = initialItem ? ((initialItem.release_date || initialItem.first_air_date || '').split('-')[0] || 'N/A') : 'N/A';
    const initRating = initialItem && initialItem.vote_average ? initialItem.vote_average.toFixed(1) : '0.0';
    const initPoster = initialItem && initialItem.poster_path ? `${IMAGE_BASE_URL}/w500${initialItem.poster_path}` : FALLBACK_POSTER;
    const initBackdrop = initialItem && initialItem.backdrop_path ? `${IMAGE_BASE_URL}/w780${initialItem.backdrop_path}` : FALLBACK_BACKDROP;

    modalTitle.textContent = initTitle;
    modalOverview.textContent = initOverview;
    modalYear.textContent = initYear;
    modalRating.innerHTML = `<i class="fa-solid fa-star mr-1"></i>${initRating}`;
    modalGenres.innerHTML = '';
    modalPoster.src = initPoster;
    modalBanner.style.backgroundImage = initialItem && initialItem.backdrop_path ? `url('${initBackdrop}')` : `none`;
    modalRecommendations.innerHTML = '<div class="col-span-4 text-center py-8 text-textSec text-xs"><i class="fa-solid fa-spinner animate-spin mr-1.5 text-brand"></i>Carregando recomendações...</div>';
    
    const typeText = type === 'movie' ? 'FILME' : 'SÉRIE';
    modalTypeBadge.textContent = typeText;
    modalTypeBadge.className = `text-xs px-2.5 py-1 rounded-full font-bold uppercase tracking-wider select-none inline-block ${type === 'movie' ? 'bg-brand' : 'bg-brand-dark'}`;

    detailsModal.classList.remove('hidden');
    document.body.classList.add('overflow-hidden'); // Disable background scrolling

    if (window.location.hash !== `#/detalhes/${type}/${id}`) {
        history.replaceState(null, '', `#/detalhes/${type}/${id}`);
    }

    // PARALLEL DATA FETCHING (Optimization #2 & #3): Fetch primary TMDB data & recommendations concurrently
    const [data] = await Promise.all([
        fetchFromTMDB(`/${type}/${id}`),
        loadRecommendations(id, type)
    ]);
    
    if (data) {
        currentOpenItem.data = data;
        
        // SEO friendly URL update
        const title = data.title || data.name;
        const slug = slugify(title);
        const expectedPath = `/${type === 'movie' ? 'filme' : 'serie'}/${id}-${slug}`;
        if (window.location.pathname !== expectedPath) {
            history.pushState({ id, type }, '', expectedPath);
        }
        
        // Optimized w780 Banner/Backdrop configuration (Optimization #3: 85% size reduction vs /original)
        const backdropPath = data.backdrop_path ? `${IMAGE_BASE_URL}/w780${data.backdrop_path}` : FALLBACK_BACKDROP;
        modalBanner.style.backgroundImage = `url('${backdropPath}')`;
        
        // Poster configuration
        modalPoster.src = data.poster_path ? `${IMAGE_BASE_URL}/w500${data.poster_path}` : FALLBACK_POSTER;
        
        // Metadata text setup
        modalTitle.textContent = title;
        modalOverview.textContent = data.overview || "Sinopse não disponível em português.";
        
        const year = (data.release_date || data.first_air_date || '').split('-')[0] || 'N/A';
        modalYear.textContent = year;
        
        const durationText = type === 'movie' 
            ? (data.runtime ? `${data.runtime} min` : 'Duração N/A')
            : (data.number_of_seasons ? `${data.number_of_seasons} Temporada${data.number_of_seasons > 1 ? 's' : ''}` : '1 Temporada');
        modalDuration.textContent = durationText;
        
        const rating = data.vote_average ? data.vote_average.toFixed(1) : '0.0';
        modalRating.innerHTML = `<i class="fa-solid fa-star mr-1"></i>${rating}`;
        
        // Classification Age Map based on certification logic or fallbacks
        const classification = type === 'movie' ? '14+' : '16+';
        modalClassification.textContent = classification;

        // Genres Badges setup
        modalGenres.innerHTML = '';
        if (data.genres && data.genres.length > 0) {
            data.genres.forEach(g => {
                const badge = document.createElement('span');
                badge.className = 'text-xs bg-white/10 px-3 py-1 rounded-full border border-white/5 text-white/90 hover:bg-white/20 transition-colors duration-150';
                badge.textContent = g.name;
                modalGenres.appendChild(badge);
            });
        }

        // Show/hide TV controls based on type
        if (modalTvControls) {
            if (type === 'tv') {
                modalTvControls.classList.remove('hidden');
                
                // Reset selectors
                modalSeasonSelect.innerHTML = '';
                modalEpisodeSelect.innerHTML = '';
                
                // Populate season selector from TMDB data
                if (data.seasons && data.seasons.length > 0) {
                    data.seasons.forEach(s => {
                        // Exclude season 0 (Specials)
                        if (s.season_number > 0) {
                            const opt = document.createElement('option');
                            opt.value = s.season_number;
                            opt.textContent = `Temporada ${s.season_number}`;
                            if (s.season_number === 1) opt.selected = true;
                            modalSeasonSelect.appendChild(opt);
                        }
                    });
                } else {
                    // Fallback single season
                    const opt = document.createElement('option');
                    opt.value = 1;
                    opt.textContent = 'Temporada 1';
                    modalSeasonSelect.appendChild(opt);
                }
                
                // Load episodes for season 1 initially
                if (modalSeasonSelect.value) {
                    await loadModalEpisodeList(id, parseInt(modalSeasonSelect.value), 1);
                }
                
                // Season change listener
                modalSeasonSelect.onchange = async (e) => {
                    const season = parseInt(e.target.value);
                    await loadModalEpisodeList(id, season, 1);
                };
            } else {
                modalTvControls.classList.add('hidden');
            }
        }

        // Setup Button Listeners
        modalPlayBtn.onclick = () => {
            closeDetails();
            const season = type === 'tv' && modalSeasonSelect ? parseInt(modalSeasonSelect.value) || 1 : 1;
            const episode = type === 'tv' && modalEpisodeSelect ? parseInt(modalEpisodeSelect.value) || 1 : 1;
            playMedia(id, type, title, season, episode);
        };

        updateModalListButton(id);
        modalListBtn.onclick = async () => {
            await togglePlaylistItem({
                id: data.id,
                title: title,
                poster_path: data.poster_path,
                backdrop_path: data.backdrop_path,
                type: type,
                vote_average: data.vote_average,
                release_date: data.release_date || data.first_air_date
            });
            updateModalListButton(id);
        };
    } else {
        modalTitle.textContent = "Erro de Conexão";
        modalOverview.textContent = "Incapaz de recuperar os dados da TMDB API. Verifique sua conexão ou chaves de desenvolvedor.";
    }
}

function updateModalListButton(id) {
    const isAdded = myPlaylist.some(item => item.id === id);
    if (isAdded) {
        modalListBtn.innerHTML = `<i class="fa-solid fa-check text-brand"></i><span>Remover da Lista</span>`;
    } else {
        modalListBtn.innerHTML = `<i class="fa-solid fa-plus"></i><span>Adicionar à Lista</span>`;
    }
}

async function loadRecommendations(id, type) {
    const recData = await fetchFromTMDB(`/${type}/${id}/similar`);
    modalRecommendations.innerHTML = '';
    
    if (recData && recData.results && recData.results.length > 0) {
        recData.results.slice(0, 4).forEach(item => {
            const card = document.createElement('div');
            card.className = 'bg-cardBg hover:bg-cardBgHover rounded-lg overflow-hidden border border-white/5 hover:border-brand/40 transition-all duration-300 flex flex-col cursor-pointer group';
            
            const title = item.title || item.name;
            const posterSrc = item.poster_path ? `${IMAGE_BASE_URL}/w185${item.poster_path}` : FALLBACK_POSTER;
            const year = (item.release_date || item.first_air_date || '').split('-')[0] || 'N/A';
            const rating = item.vote_average ? item.vote_average.toFixed(1) : '0.0';

            card.innerHTML = `
                <div class="relative aspect-[16/10] overflow-hidden bg-zinc-900">
                    <img src="${item.backdrop_path ? IMAGE_BASE_URL + '/w300' + item.backdrop_path : posterSrc}" alt="${title}" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500">
                </div>
                <div class="p-2 sm:p-3 flex-grow flex flex-col justify-between">
                    <h4 class="font-bold text-xs text-white line-clamp-1 group-hover:text-brand transition-colors duration-200">${title}</h4>
                    <div class="flex items-center justify-between text-[10px] text-textSec mt-1">
                        <span>${year}</span>
                        <span class="text-rating font-bold"><i class="fa-solid fa-star text-[8px] mr-0.5"></i> ${rating}</span>
                    </div>
                </div>
            `;

            card.addEventListener('click', (e) => {
                e.stopPropagation();
                openDetailsModal(item.id, type); // Switch detail view
            });

            modalRecommendations.appendChild(card);
        });
    } else {
        modalRecommendations.innerHTML = `<div class="col-span-4 text-center py-4 text-textSec text-xs">Nenhum título semelhante encontrado</div>`;
    }
}

function closeDetails() {
    detailsModal.classList.add('hidden');
    document.body.classList.remove('overflow-hidden');
    currentOpenItem = null;
    
    if (window.location.hash.startsWith('#/detalhes/')) {
        history.replaceState(null, '', '#/');
    }
    // Restore home URL path if on a SEO friendly path
    if (window.location.pathname.startsWith('/filme/') || window.location.pathname.startsWith('/serie/')) {
        history.pushState(null, '', '/');
    }
}

closeDetailsBtn.addEventListener('click', closeDetails);
detailsModal.addEventListener('click', (e) => {
    if (e.target === detailsModal) closeDetails(); // Close clicking backdrop
});

/**
 * PLAYLIST SYSTEM ("Minha Lista")
 * Backed by the server's /api/favorites — the same account's list shows up
 * identically on web, mobile and TV. Never touches localStorage for the
 * actual list data anymore (see myPlaylist declaration above).
 */

/** Fetches the current user's favorites from the server and maps them into
 * the {id, type, poster_path, title, ...} shape the rest of this file (createPosterCard,
 * updateHeroListButton, etc.) already expects — same field names TMDB itself uses. */
async function loadPlaylist() {
    const user = JSON.parse(localStorage.getItem('brflix-user'));
    if (!user) {
        myPlaylist = [];
        return;
    }
    try {
        const { favorites } = await apiFetch('/api/favorites');
        myPlaylist = (favorites || []).map(f => ({
            id: f.tmdbId,
            type: f.mediaType,
            title: f.title,
            poster_path: f.posterPath,
        }));
        await migrateLegacyLocalPlaylist();
    } catch (err) {
        console.warn('[Playlist] Failed to load favorites from server:', err.message);
        myPlaylist = [];
    }
}

/** One-time migration for users who had titles saved under the old localStorage-only
 * system (pre-server-sync). Pushes any legacy item not already in the server list up
 * via POST, then wipes the legacy key so this never re-runs. Runs only after loadPlaylist's
 * own fetch succeeded above — if the server is unreachable we'd rather leave the legacy
 * data alone than risk losing it. */
async function migrateLegacyLocalPlaylist() {
    if (localStorage.getItem('brflix-playlist-migrated')) return;
    let legacyItems = [];
    try {
        legacyItems = JSON.parse(localStorage.getItem('brflix-playlist')) || [];
    } catch (e) {
        legacyItems = [];
    }
    if (legacyItems.length === 0) {
        localStorage.setItem('brflix-playlist-migrated', '1');
        localStorage.removeItem('brflix-playlist');
        return;
    }

    const existingKeys = new Set(myPlaylist.map(p => `${p.id}-${p.type}`));
    const toMigrate = legacyItems.filter(item => item && item.id && item.type && !existingKeys.has(`${item.id}-${item.type}`));

    try {
        await Promise.all(toMigrate.map(item => apiFetch('/api/favorites', {
            method: 'POST',
            body: JSON.stringify({ tmdbId: item.id, mediaType: item.type, title: item.title, posterPath: item.poster_path }),
        })));
        myPlaylist = myPlaylist.concat(toMigrate);
        localStorage.setItem('brflix-playlist-migrated', '1');
        localStorage.removeItem('brflix-playlist');
        if (toMigrate.length > 0) {
            console.info(`[Playlist] Migrated ${toMigrate.length} legacy local title(s) to the server.`);
        }
    } catch (err) {
        // Leave the legacy key intact — we'll retry this migration on the next load.
        console.warn('[Playlist] Legacy playlist migration failed, will retry later:', err.message);
    }
}

/** Removes every favorite from the server. There's no bulk-delete endpoint, so this
 * fires one DELETE per item (favorites lists are small — dozens, not thousands). */
async function clearPlaylist() {
    const items = myPlaylist;
    myPlaylist = [];
    try {
        await Promise.all(items.map(item => apiFetch('/api/favorites', {
            method: 'DELETE',
            body: JSON.stringify({ tmdbId: item.id, mediaType: item.type }),
        })));
    } catch (err) {
        console.error('[Playlist] Failed to clear favorites on the server:', err.message);
    }
}

function initPlaylist() {
    renderPlaylist();
    
    clearListBtn.addEventListener('click', async () => {
        await clearPlaylist();
        renderPlaylist();
        showToast("Minha lista foi limpa!");
        if (currentOpenItem) updateModalListButton(currentOpenItem.id);
        updateHeroListButton(211684);
    });
}

async function togglePlaylistItem(item) {
    const user = JSON.parse(localStorage.getItem('brflix-user'));
    if (!user) {
        showToast("Faça login para adicionar títulos à sua lista!");
        setTimeout(() => {
            window.location.hash = '#/login';
        }, 1200);
        return;
    }
    const index = myPlaylist.findIndex(p => p.id === item.id && p.type === item.type);
    try {
        if (index > -1) {
            await apiFetch('/api/favorites', {
                method: 'DELETE',
                body: JSON.stringify({ tmdbId: item.id, mediaType: item.type }),
            });
            myPlaylist.splice(index, 1);
            showToast(`"${item.title}" removido da sua lista.`);
        } else {
            await apiFetch('/api/favorites', {
                method: 'POST',
                body: JSON.stringify({ tmdbId: item.id, mediaType: item.type, title: item.title, posterPath: item.poster_path }),
            });
            myPlaylist.push(item);
            showToast(`"${item.title}" adicionado à sua lista.`);
        }
    } catch (err) {
        showToast('Não foi possível atualizar sua lista. Tente novamente.');
        console.error('[Playlist] Failed to sync favorite with the server:', err.message);
        return;
    }
    renderPlaylist();
}

function renderPlaylist() {
    if (!myListCarousel) return;
    myListCarousel.innerHTML = '';
    
    if (myPlaylist.length === 0) {
        myListSection.classList.add('hidden');
        return;
    }
    
    myListSection.classList.remove('hidden');
    
    myPlaylist.forEach(item => {
        const card = createPosterCard(item, item.type);
        myListCarousel.appendChild(card);
    });
}

function shouldShowDailyVastAd() {
    return false;
}

function markDailyVastAdSeen() {}

async function playDailyVastAd(onComplete) {
    if (typeof onComplete === 'function') onComplete();
}

// ═══════════════════════════════════════════════════════════════════════════
// MONETAG AD MANAGEMENT — Dynamic Script Loading & Player Protection
// ═══════════════════════════════════════════════════════════════════════════
// ALL Monetag scripts are loaded dynamically by JS. NONE are in the HTML.
// When the player opens, all ad scripts and their injected DOM nodes are
// physically REMOVED from the page. When the player closes, they are
// re-injected after respecting frequency caps.
// ═══════════════════════════════════════════════════════════════════════════

const NOTIFICATION_COOLDOWN_MS = 5 * 60 * 1000;   // 5 min between In-Page Push
const POPUNDER_COOLDOWN_MS     = 10 * 60 * 1000;  // 10 min between Popunders
let pushScriptActive = false;
let browserPushLoaded = false;
let popunderScriptLoaded = false;

/**
 * Checks if the current user has an active Premium (paid) subscription.
 * PREMIUM USERS NEVER SEE ANY ADS ON THE ENTIRE WEBSITE!
 */
function isPremiumUser() {
    try {
        const token = localStorage.getItem('brflix-token');
        if (!token) return false;

        const userStr = localStorage.getItem('brflix-user');
        if (userStr) {
            const user = JSON.parse(userStr);
            if (user && (user.is_premium === true || user.isPremium === true)) return true;
            if (user && user.plan_code && user.plan_code !== 'free') return true;
            if (user && user.plan && user.plan.code && user.plan.code !== 'free') return true;
        }

        if (localStorage.getItem('brflix-is-premium') === 'true') return true;
        return false;
    } catch (e) {
        return false;
    }
}

function isPlayerActive() {
    return document.body.classList.contains('in-player-mode') ||
        (document.getElementById('player-modal') && !document.getElementById('player-modal').classList.contains('hidden'));
}

// ─── Absolute Popunder Shield for Premium Users & Player Mode ───
const _originalWindowOpenFunc = window.open;
window.open = function(url, target, features) {
    if (isPremiumUser()) {
        debugLog('[Ads] Popunder window.open BLOCKED: User is Premium.');
        return null;
    }

    // Always ALLOW Adtize (CashAds / Shopee sponsor gate) window.open calls!
    const urlStr = String(url || '').toLowerCase();
    const isAdtizeClick = document.activeElement && (
        (document.activeElement.id || '').toLowerCase().includes('cashads') ||
        (document.activeElement.className || '').toString().toLowerCase().includes('cashads') ||
        (document.activeElement.id || '').toLowerCase().includes('adtize') ||
        (document.activeElement.closest && document.activeElement.closest('#cashads-overlay'))
    );

    if (urlStr.includes('adtize') || urlStr.includes('cashads') || urlStr.includes('gate') || urlStr.includes('shopee') || isAdtizeClick || !isPlayerActive()) {
        return _originalWindowOpenFunc.apply(this, arguments);
    }

    debugLog('[Ads] Popunder window.open BLOCKED: Player is active.');
    return null;
};

// ─── Destroy ALL Adsterra & Monetag DOM nodes (scripts + rendered elements) ───
function destroyAllAdElements() {
    // 1. Remove ALL Adsterra, Monetag, and MyPopAds script tags
    document.querySelectorAll(
        'script[src*="effectivecpmnetwork"], script[src*="highperformanceformat"], ' +
        'script[src*="nap5k"], script[src*="al5sm"], script[src*="n6wxm"], script[src*="5gvci"], ' +
        'script[src*="mypopads"], script[src*="developersone"], script[data-zone]'
    ).forEach(el => el.remove());

    // 2. Remove ALL ad container elements
    document.querySelectorAll(
        '[id*="container-f33bfc"], [data-zone], iframe[src*="effectivecpmnetwork"], ' +
        'iframe[src*="highperformanceformat"], iframe[src*="nap5k"], iframe[src*="al5sm"], ' +
        'iframe[src*="n6wxm"], iframe[src*="5gvci"], iframe[src*="monetag"], ' +
        '[class*="nap5k"], [id*="nap5k"], [class*="al5sm"], [id*="al5sm"]'
    ).forEach(el => {
        if (el.id === 'app' || el.id === 'player-modal' || el.closest('#player-modal')) return;
        el.remove();
    });

    // 3. Remove ANY unknown fixed/absolute-position element from body root (excluding app containers, mobile nav, and Adtize 24h unlock modal)
    const knownIds = ['app', 'player-modal', 'details-modal', 'auth-modal', 'adblock-modal', 'discord-daily-modal', 'toast-container', 'main-header', 'adtize-ads-script', 'mobile-menu', 'mobile-bottom-nav', 'cashads-overlay', 'cashads-gate-style'];
    const knownTags = ['SCRIPT', 'STYLE', 'LINK', 'NOSCRIPT', 'META', 'HEADER', 'NAV', 'FOOTER', 'MAIN'];

    Array.from(document.body.children).forEach(el => {
        if (!el || el.nodeType !== 1) return;
        if (knownIds.includes(el.id) || knownTags.includes(el.tagName) || el.closest('#main-header') || el.closest('#app')) return;

        // Preserve Adtize (CashAds) 24h Unlock Gate elements for free users
        const elId = (el.id || '').toLowerCase();
        const elCls = (el.className || '').toString().toLowerCase();
        const elSrc = (el.src || '').toLowerCase();
        if (elId.includes('adtize') || elId.includes('cashads') || elCls.includes('adtize') || elCls.includes('cashads') || elSrc.includes('adtize') || elSrc.includes('cashads')) {
            if (isPremiumUser()) {
                el.remove(); // Remove for Premium users (Premium never sees ads)
            }
            return;
        }

        try {
            const cs = window.getComputedStyle(el);
            if (cs.position === 'fixed' || cs.position === 'absolute') {
                el.remove();
            }
        } catch (e) {}
    });

    // 4. Remove ALL non-player iframes across the entire document
    document.querySelectorAll('iframe').forEach(iframe => {
        if (iframe.id === 'player-iframe' || iframe.closest('#player-modal')) return;
        const iframeSrc = (iframe.src || '').toLowerCase();
        if (iframeSrc.includes('adtize') || iframeSrc.includes('cashads')) {
            if (isPremiumUser()) iframe.remove();
            return;
        }
        iframe.remove();
    });

    // Premium Protection: Set 1-year Adtize cooldown for Premium users
    if (isPremiumUser()) {
        try {
            localStorage.setItem('cashads_cooldown_c228717bf66449b01b00a8c1c6d955e1', String(Date.now() + 365 * 24 * 3600 * 1000));
        } catch (e) {}
    }

    adsterraPopunderActive = false;
    adsterraSocialBarLoaded = false;
}

// ─── Monetag Popunder (Zone 11493970, 10-minute frequency capping, catalog only, 0 for Premium/Player) ───
const MONETAG_POPUNDER_COOLDOWN_MS = 10 * 60 * 1000;
let monetagPopunderActive = false;
let adsterraSocialBarLoaded = false;

function maybeLoadMonetagPopunder() {
    if (isPremiumUser() || isPlayerActive() || monetagPopunderActive) return;

    const lastFired = parseInt(localStorage.getItem('monetag_popunder_last_fired') || '0', 10);
    const now = Date.now();
    if (lastFired > 0 && (now - lastFired < MONETAG_POPUNDER_COOLDOWN_MS)) return;

    // Load Monetag Popunder script (Zone 11493970)
    if (!document.getElementById('monetag-popunder-script')) {
        const parent = [document.documentElement, document.body].filter(Boolean).pop() || document.body;
        const s = document.createElement('script');
        s.id = 'monetag-popunder-script';
        s.dataset.zone = '11493970';
        s.src = 'https://al5sm.com/tag.min.js';
        s.async = true;
        parent.appendChild(s);
    }

    monetagPopunderActive = true;
    localStorage.setItem('monetag_popunder_last_fired', String(now));
    debugLog('[Monetag] Popunder script loaded (Zone 11493970). 10-minute cooldown started.');

    // Auto-reset active flag after 4 seconds
    setTimeout(() => {
        document.querySelectorAll('#monetag-popunder-script').forEach(el => el.remove());
        monetagPopunderActive = false;
    }, 4000);
}

// ─── Adsterra Social Bar (Catalog only for free users, 0 for Premium/Player) ───
function maybeLoadAdsterraSocialBar() {
    if (isPremiumUser() || isPlayerActive() || adsterraSocialBarLoaded) return;

    if (!document.getElementById('adsterra-socialbar-script')) {
        const s = document.createElement('script');
        s.src = 'https://pl30673218.effectivecpmnetwork.com/46/c8/e8/46c8e8f7200c8c7de69b88cc8916c262.js';
        s.id = 'adsterra-socialbar-script';
        document.body.appendChild(s);
        adsterraSocialBarLoaded = true;
        debugLog('[Adsterra] Social Bar script loaded.');
    }
}

// ─── Master Ad Tick (runs every 5 seconds) ───
function adManagerTick() {
    // 0 ADS FOR PREMIUM USERS ACROSS THE ENTIRE WEBSITE!
    if (isPremiumUser()) {
        destroyAllAdElements();
        return;
    }
    if (isPlayerActive()) return; // Never load anything during player
    maybeLoadAdsterraSocialBar();
}

setInterval(adManagerTick, 5000);
setTimeout(adManagerTick, 3000); // Initial load after page ready

// ─── Player enter/exit hooks ───
const ADTIZE_TOKEN = 'c228717bf66449b01b00a8c1c6d955e1';
let activeAdtizeUnlockPoll = null;

function isAdtize24hUnlocked() {
    if (isPremiumUser()) return true;
    try {
        const val = localStorage.getItem('cashads_cooldown_' + ADTIZE_TOKEN);
        if (!val) return false;
        const exp = parseInt(val, 10);
        return !isNaN(exp) && Date.now() < exp;
    } catch (e) {
        return true;
    }
}

function getOrCreateCashadsVisitorId() {
    const key = 'cashads_visitor_id';
    let id = null;
    try { id = localStorage.getItem(key); } catch (e) {}
    if (!id) {
        id = 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9);
        try { localStorage.setItem(key, id); } catch (e) {}
    }
    return id;
}

function launchAdtizeGateInstant() {
    const token = ADTIZE_TOKEN;
    const visitorId = getOrCreateCashadsVisitorId();
    const apiUrl = `https://adtize.com.br/api/ad-config.php?token=${encodeURIComponent(token)}&visitor_id=${encodeURIComponent(visitorId)}`;

    fetch(apiUrl)
        .then(r => r.json())
        .then(config => {
            if (!config || config.available === false || !config.link) {
                // Auto unlock if no ad config is returned so player doesn't hang
                localStorage.setItem('cashads_cooldown_' + token, String(Date.now() + 24 * 3600 * 1000));
                return;
            }

            const proceed = () => {
                if (window.CashAdsGate && typeof window.CashAdsGate.initFlow === 'function') {
                    window.CashAdsGate.initFlow({
                        token: token,
                        url: config.link,
                        visitor_id: visitorId,
                        click_token: config.click_token || '',
                        ad_type: config.ad_type || 'modal',
                        page_url: window.location.href,
                        referrer: document.referrer || '',
                        client: {
                            language: navigator.language || '',
                            platform: navigator.platform || '',
                            timezone: (window.Intl && Intl.DateTimeFormat) ? (Intl.DateTimeFormat().resolvedOptions().timeZone || '') : '',
                            screen: window.screen ? (screen.width + 'x' + screen.height) : '',
                            viewport: window.innerWidth + 'x' + window.innerHeight
                        },
                        onRedirected: () => {
                            localStorage.setItem('cashads_cooldown_' + token, String(Date.now() + 24 * 3600 * 1000));
                        },
                        onExpired: () => {
                            localStorage.setItem('cashads_cooldown_' + token, String(Date.now() + 24 * 3600 * 1000));
                        },
                        onRemoved: () => {
                            localStorage.setItem('cashads_cooldown_' + token, String(Date.now() + 24 * 3600 * 1000));
                        }
                    });

                    // Force Adtize overlay into #player-modal with highest z-index so it appears ON TOP of player loader
                    const ensureOverlayOnTop = () => {
                        const overlay = document.getElementById('cashads-overlay');
                        const playerModal = document.getElementById('player-modal');
                        if (overlay && playerModal) {
                            overlay.style.zIndex = '2147483647';
                            if (overlay.parentElement !== playerModal) {
                                playerModal.appendChild(overlay);
                            }
                        }
                    };
                    setTimeout(ensureOverlayOnTop, 20);
                    setTimeout(ensureOverlayOnTop, 150);
                    setTimeout(ensureOverlayOnTop, 400);
                }
            };

            if (window.CashAdsGate) {
                proceed();
            } else {
                let gateScript = document.getElementById('cashads-gate-script');
                if (!gateScript) {
                    gateScript = document.createElement('script');
                    gateScript.id = 'cashads-gate-script';
                    gateScript.src = 'https://adtize.com.br/js/gate.js';
                    gateScript.onload = proceed;
                    gateScript.onerror = () => {
                        localStorage.setItem('cashads_cooldown_' + token, String(Date.now() + 24 * 3600 * 1000));
                    };
                    document.head.appendChild(gateScript);
                } else {
                    proceed();
                }
            }
        })
        .catch(() => {
            localStorage.setItem('cashads_cooldown_' + token, String(Date.now() + 24 * 3600 * 1000));
        });
}

let playerAdCheckInterval = null;

function hideAllFloatingAds() {
    // Immediately destroy all ad elements
    destroyAllAdElements();
    // Keep checking in case Monetag tries to re-inject
    if (!playerAdCheckInterval) {
        playerAdCheckInterval = setInterval(destroyAllAdElements, 500);
    }
}

function restoreFloatingAds() {
    if (playerAdCheckInterval) {
        clearInterval(playerAdCheckInterval);
        playerAdCheckInterval = null;
    }
    if (activeAdtizeUnlockPoll) {
        clearInterval(activeAdtizeUnlockPoll);
        activeAdtizeUnlockPoll = null;
    }
    // Ads will be re-loaded naturally by adManagerTick after their cooldowns
    debugLog('[Ads] Player closed. Ads will reload after cooldown expires.');
}

async function playMedia(tmdbId, type, title, season = 1, episode = 1) {
    // Set UI configuration immediately with title
    playerTitle.textContent = title.toUpperCase();

    // Check if free user needs to complete the 24h Adtize Player Unlock for their first video of the day
    if (!isAdtize24hUnlocked()) {
        playerSubtitle.textContent = '🔒 Clique no botão do patrocinador para liberar o player por 24 horas...';

        if (playerModal && playerModal.parentElement !== document.body) {
            document.body.appendChild(playerModal);
        }
        playerLoader.classList.remove('hidden');
        playerModal.classList.remove('hidden');
        document.body.classList.add('overflow-hidden', 'in-player-mode');

        // Trigger Adtize 24h Unlock modal instantly (bypassing 10-second delay)
        launchAdtizeGateInstant();

        // 30s Safety Net: Only fallback if Adtize network completely fails after 30 seconds
        const safetyTimeout = setTimeout(() => {
            if (!isAdtize24hUnlocked()) {
                debugLog('[Adtize] 30s timeout reached. Auto-unlocking 24h access.');
                localStorage.setItem('cashads_cooldown_' + ADTIZE_TOKEN, String(Date.now() + 24 * 3600 * 1000));
            }
        }, 30000);

        // Wait until Adtize 24h unlock is completed or player is closed
        await new Promise((resolve) => {
            if (activeAdtizeUnlockPoll) clearInterval(activeAdtizeUnlockPoll);
            activeAdtizeUnlockPoll = setInterval(() => {
                if (isAdtize24hUnlocked() || !isPlayerActive()) {
                    clearTimeout(safetyTimeout);
                    clearInterval(activeAdtizeUnlockPoll);
                    activeAdtizeUnlockPoll = null;
                    resolve();
                }
            }, 300);
        });

        if (!isPlayerActive()) return; // User closed player before unlocking
    }

    playerSubtitle.textContent = 'Carregando stream seguro...';

    // Show loading spinner & isolate player modal at body root
    if (playerModal && playerModal.parentElement !== document.body) {
        document.body.appendChild(playerModal);
    }
    playerLoader.classList.remove('hidden');
    playerModal.classList.remove('hidden');
    document.body.classList.add('overflow-hidden', 'in-player-mode');
    hideAllFloatingAds();

    if (getAuthToken()) {
        try {
            await apiFetch('/api/subscription/watch-start', { method: 'POST' });
        } catch (err) {
            showScreenLimitModal(err.message || 'Limite de telas simultâneas atingido.');
            return;
        }
    }
    isPlayerWatching = true;

    let imdbId = '';
    try {
        const extData = await fetchFromTMDB(`/${type}/${tmdbId}/external_ids`);
        if (extData && extData.imdb_id) {
            imdbId = extData.imdb_id;
            debugLog(`Found IMDb ID for ${title}: ${imdbId}`);
        }
    } catch (err) {
        console.error('Error fetching external IDs from TMDB:', err);
    }

    currentOpenItem = { id: tmdbId, type: type, title: title, imdbId: imdbId };
    currentEpisodeState = { season, episode };
    
    if (type === 'tv') {
        playerTvControls.classList.remove('hidden');
        await populateEpisodeSelectors(tmdbId, season, episode);
    } else {
        playerTvControls.classList.add('hidden');
    }
    
    loadPlayerStream();
}

/** Tells the backend playback stopped, freeing this screen's slot in the plan's simultaneous-watching cap immediately instead of waiting out the ~60s heartbeat window (see server/subscription.js stopWatching). Fire-and-forget: a failure here just means the slot frees up on the next heartbeat/timeout instead of instantly, not worth blocking the UI over. */
function stopWatchingApi() {
    if (!getAuthToken()) return;
    apiFetch('/api/subscription/watch-stop', { method: 'POST' }).catch((err) => {
        console.warn('[Subscription] Failed to report watch-stop:', err.message);
    });
}

async function loadPlayerStream() {
    playerLoader.classList.remove('hidden');
    
    const requestId = ++currentStreamRequestId;
    currentPlayingUrl = ''; // Clear currently playing URL since we are starting a new resolution
    
    // Destroy previous Hls instance to avoid background downloads
    if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
    }
    
    // Reset players: hide native player and show iframe
    if (playerNative) {
        playerNative.classList.add('hidden');
        playerNative.removeAttribute('src');
        playerNative.load();
    }
    if (playerNativeControls) {
        playerNativeControls.classList.add('hidden');
    }

    playerIframe.classList.remove('hidden');
    playerIframe.removeAttribute('src');
    
    // Reset custom overlays
    playerOverlayControls.classList.remove('hidden');
    
    const providerKey = playerServerSelect.value;
    const provider = PROVIDERS[providerKey];
    
    const id = currentOpenItem.id;
    const imdb = currentOpenItem.imdbId || '';
    
    const dubbedParam = currentAudioPreference === 'dubbed' ? '1' : '0';
    let url = '';
    if (currentOpenItem.type === 'movie') {
        url = provider.movie(id, imdb);
    } else {
        url = provider.tv(id, currentEpisodeState.season, currentEpisodeState.episode, imdb);
    }
    if (url && typeof url === 'string' && providerKey !== 'native_premium' && !url.includes('dubbed=')) {
        url += (url.includes('?') ? '&' : '?') + `dubbed=${dubbedParam}`;
    }
    
    // Manage sandbox attribute: ONLY apply to EmbedMovies provider
    if (providerKey === 'embedmovies') {
        debugLog("[Player] Applying sandbox rules for EmbedMovies server.");
        playerIframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-presentation allow-pointer-lock');
    } else {
        debugLog(`[Player] Removing sandbox for ${providerKey} server.`);
        playerIframe.removeAttribute('sandbox');
    }
    
    // Save to Continue Watching history
    updateContinueWatching(id, currentOpenItem.type, currentOpenItem.title, currentEpisodeState.season, currentEpisodeState.episode);
    
    // Reset intro timers for new stream
    clearIntroTimers();
    introIframeReady = false;
    
    if (providerKey === 'native_premium') {
        if (playerCustomFullscreenBtn) playerCustomFullscreenBtn.classList.add('hidden');
        playerSubtitle.textContent = 'Buscando melhor transmissão nativa (Sem Anúncios)...';
        isNativeFailoverActive = true;
        
        // Order matters: MegaEmbed/EmbedMovies are tried before ClickHost because
        // ClickHost's "Fonte 1" defaults to a subtitled (legendado) audio track for
        // some anime titles (e.g. Black Clover) instead of dubbed, with no way to
        // request dubbed audio directly from its API — so it's kept as the last
        // resort, only used when the other two providers don't have the title.
        const dubbedParam = currentAudioPreference === 'dubbed' ? '1' : '0';
        const isMovie = currentOpenItem.type === 'movie';
        
        // Dynamic provider prioritization: Movies prioritize MegaEmbed/EmbedMovies for Dublado, but prioritize FenixFlix for Subtitled/Legendado
        const methods = isMovie ? (currentAudioPreference === 'subtitled' ? [
            {
                name: 'BestStream',
                resolver: () => resolveBestAvailableStream('movie', id, imdb, currentEpisodeState.season, currentEpisodeState.episode)
            },
            {
                name: 'FenixFlix',
                resolver: () => resolveFenixFlixStream('movie', id, imdb, currentEpisodeState.season, currentEpisodeState.episode)
            },
            {
                name: 'MegaEmbed',
                resolver: () => {
                    let megaembedUrl = PROVIDERS['megaembed'].movie(id, imdb);
                    megaembedUrl += (megaembedUrl.includes('?') ? '&' : '?') + `dubbed=${dubbedParam}`;
                    return resolveMegaEmbedStream(megaembedUrl);
                }
            },
            {
                name: 'EmbedMovies',
                resolver: () => {
                    let embedmoviesUrl = PROVIDERS['embedmovies'].movie(id, imdb);
                    embedmoviesUrl += (embedmoviesUrl.includes('?') ? '&' : '?') + `dubbed=${dubbedParam}`;
                    return resolveEmbedMoviesStream(embedmoviesUrl);
                }
            },
            {
                name: 'ClickHost',
                resolver: () => {
                    let clickhostUrl = PROVIDERS['clickhost'].movie(id, imdb);
                    clickhostUrl += (clickhostUrl.includes('?') ? '&' : '?') + `dubbed=${dubbedParam}`;
                    return resolveClickHostStream(clickhostUrl);
                }
            }
        ] : [
            {
                name: 'BestStream',
                resolver: () => resolveBestAvailableStream('movie', id, imdb, currentEpisodeState.season, currentEpisodeState.episode)
            },
            {
                name: 'MegaEmbed',
                resolver: () => {
                    let megaembedUrl = PROVIDERS['megaembed'].movie(id, imdb);
                    megaembedUrl += (megaembedUrl.includes('?') ? '&' : '?') + `dubbed=${dubbedParam}`;
                    return resolveMegaEmbedStream(megaembedUrl);
                }
            },
            {
                name: 'EmbedMovies',
                resolver: () => {
                    let embedmoviesUrl = PROVIDERS['embedmovies'].movie(id, imdb);
                    embedmoviesUrl += (embedmoviesUrl.includes('?') ? '&' : '?') + `dubbed=${dubbedParam}`;
                    return resolveEmbedMoviesStream(embedmoviesUrl);
                }
            },
            {
                name: 'FenixFlix',
                resolver: () => resolveFenixFlixStream('movie', id, imdb, currentEpisodeState.season, currentEpisodeState.episode)
            },
            {
                name: 'ClickHost',
                resolver: () => {
                    let clickhostUrl = PROVIDERS['clickhost'].movie(id, imdb);
                    clickhostUrl += (clickhostUrl.includes('?') ? '&' : '?') + `dubbed=${dubbedParam}`;
                    return resolveClickHostStream(clickhostUrl);
                }
            },
            {
                name: 'AnimeFire',
                resolver: () => resolveAnimeFireStream('movie', id, imdb, currentEpisodeState.season, currentEpisodeState.episode, currentOpenItem?.title)
            }
        ]) : [
            {
                name: 'BestStream',
                resolver: () => resolveBestAvailableStream('tv', id, imdb, currentEpisodeState.season, currentEpisodeState.episode)
            },
            {
                name: 'FenixFlix',
                resolver: () => resolveFenixFlixStream('tv', id, imdb, currentEpisodeState.season, currentEpisodeState.episode)
            },
            {
                name: 'ClickHost',
                resolver: () => {
                    let clickhostUrl = PROVIDERS['clickhost'].tv(id, currentEpisodeState.season, currentEpisodeState.episode, imdb);
                    clickhostUrl += (clickhostUrl.includes('?') ? '&' : '?') + `dubbed=${dubbedParam}`;
                    return resolveClickHostStream(clickhostUrl);
                }
            },
            {
                name: 'EmbedMovies',
                resolver: () => {
                    let embedmoviesUrl = PROVIDERS['embedmovies'].tv(id, currentEpisodeState.season, currentEpisodeState.episode, imdb);
                    embedmoviesUrl += (embedmoviesUrl.includes('?') ? '&' : '?') + `dubbed=${dubbedParam}`;
                    return resolveEmbedMoviesStream(embedmoviesUrl);
                }
            },
            {
                name: 'MegaEmbed',
                resolver: () => {
                    let megaembedUrl = PROVIDERS['megaembed'].tv(id, currentEpisodeState.season, currentEpisodeState.episode, imdb);
                    megaembedUrl += (megaembedUrl.includes('?') ? '&' : '?') + `dubbed=${dubbedParam}`;
                    return resolveMegaEmbedStream(megaembedUrl);
                }
            },
            {
                name: 'AnimeFire',
                resolver: () => resolveAnimeFireStream('tv', id, imdb, currentEpisodeState.season, currentEpisodeState.episode, currentOpenItem?.title)
            }
        ];
        
        // Attempt each streaming method sequentially with automatic fast failover
        (async () => {
            let lastResortIframeUrl = null; // Saved iframe URL if native HLS fails entirely
            for (let i = 0; i < methods.length; i++) {
                const method = methods[i];
                if (requestId !== currentStreamRequestId) {
                    isNativeFailoverActive = false;
                    return;
                }
                
                playerSubtitle.textContent = `Tentando conectar ao servidor ${method.name}...`;
                debugLog(`[Player] Attempting native play via method: ${method.name}`);
                
                try {
                    const resolved = await method.resolver();
                    if (requestId !== currentStreamRequestId) {
                        isNativeFailoverActive = false;
                        return;
                    }
                    
                    const candidateList = typeof resolved === 'object' && resolved !== null && resolved.candidates
                        ? resolved.candidates
                        : (resolved ? [{ url: typeof resolved === 'string' ? resolved : resolved.url, provider: method.name }] : []);

                    for (const candidate of candidateList) {
                        if (!candidate || !candidate.url) continue;
                        if (requestId !== currentStreamRequestId) {
                            isNativeFailoverActive = false;
                            return;
                        }

                        // Skip non-native URLs (iframes, Blogger video pages, etc.) — they cannot
                        // be fed to the native HLS/MP4 player and cause the #EXTM3U header error.
                        const candidateUrl = candidate.url;
                        const isNativeStreamable = candidateUrl.includes('.m3u8') || candidateUrl.includes('.mp4') ||
                            candidateUrl.includes('/hls/') || candidateUrl.startsWith('/embedplayer-proxy') ||
                            candidateUrl.startsWith('/dynamic-proxy') || candidateUrl.startsWith('/megaembed-proxy') ||
                            candidateUrl.startsWith('/clickhost-proxy');
                        if (!isNativeStreamable) {
                            // Save as last resort — may be used if all native methods fail
                            if (!lastResortIframeUrl) lastResortIframeUrl = candidateUrl;
                            debugLog(`[Player] Skipping non-native URL (type: ${candidate.type || 'iframe'}): ${candidateUrl.substring(0, 80)}`);
                            continue;
                        }

                        // Skip dubbed candidates only if a subtitled candidate is preferred and available
                        if (currentAudioPreference === 'subtitled' && candidate.dubbed === true && candidateList.some(c => c && c.dubbed === false)) {
                            debugLog(`[Player] Skipping dubbed native candidate ${candidate.provider} in favor of explicit subtitled stream.`);
                            continue;
                        }

                        const candidateName = candidate.provider || method.name;
                        playerSubtitle.textContent = `Iniciando reprodução nativa (${candidateName})...`;
                        
                        if (candidate.url.includes('lightspeedst.net') || candidate.provider === 'AnimeFire') {
                            debugLog(`[Player] Direct AnimeFire playback via srcdoc: ${candidate.url}`);
                            playerIframe.classList.remove('hidden');
                            if (playerNative) playerNative.classList.add('hidden');
                            if (playerNativeControls) playerNativeControls.classList.add('hidden');
                            if (playerCustomFullscreenBtn) playerCustomFullscreenBtn.classList.remove('hidden');
                            
                            playerIframe.srcdoc = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="referrer" content="no-referrer">
    <style>
        html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #000; overflow: hidden; display: flex; align-items: center; justify-content: center; }
        video { width: 100%; height: 100%; object-fit: contain; outline: none; }
    </style>
</head>
<body>
    <video src="${candidate.url}" controls autoplay playsinline style="width:100%;height:100%;"></video>
</body>
</html>`;
                            playerSubtitle.textContent = currentOpenItem.type === 'movie' 
                                ? `Filme Completo • Servidor: ${candidateName}`
                                : `T${currentEpisodeState.season}:Ep${currentEpisodeState.episode} • Servidor: ${candidateName}`;
                            playerLoader.classList.add('hidden');
                            isNativeFailoverActive = false;
                            return;
                        }
                        
                        try {
                            await new Promise((resolve, reject) => {
                                const timeoutId = setTimeout(() => {
                                    cleanup();
                                    reject(new Error('Timeout loading media'));
                                }, 15000); // 15.0s buffering window to allow high-bitrate VOD/HLS streams to buffer cleanly on slower connections
                                
                                const onLoadedMetadata = () => {
                                    const duration = playerNative.duration;
                                    if (Number.isFinite(duration) && duration > 0 && duration < MIN_VALID_STREAM_DURATION_SECONDS) {
                                        cleanup();
                                        reject(new Error(`Placeholder/offline clip detected (duration: ${duration.toFixed(1)}s)`));
                                        return;
                                    }
                                    revealNativePlayer();
                                    cleanup();
                                    resolve();
                                };
                                
                                const onPlay = () => {
                                    revealNativePlayer();
                                    cleanup();
                                    resolve();
                                };
                                
                                const onError = (e) => {
                                    cleanup();
                                    reject(new Error('Format error / 502 Bad Gateway'));
                                };
                                
                                playerNative.addEventListener('loadedmetadata', onLoadedMetadata);
                                playerNative.addEventListener('loadeddata', onPlay);
                                playerNative.addEventListener('canplay', onPlay);
                                playerNative.addEventListener('playing', onPlay);
                                playerNative.addEventListener('error', onError);
                                
                                function cleanup() {
                                    clearTimeout(timeoutId);
                                    if (playerNative) {
                                        playerNative.removeEventListener('loadedmetadata', onLoadedMetadata);
                                        playerNative.removeEventListener('loadeddata', onPlay);
                                        playerNative.removeEventListener('playing', onPlay);
                                        playerNative.removeEventListener('canplay', onPlay);
                                        playerNative.removeEventListener('error', onError);
                                    }
                                }
                                
                                initializeNativePlayer(candidate.url);
                            });

                            // Success!
                            isNativeFailoverActive = false;
                            debugLog(`[Player] Native playback started successfully via: ${candidateName}`);
                            if (currentOpenItem.type === 'tv') {
                                checkIntroTimestamps(id, currentEpisodeState.season, currentEpisodeState.episode);
                            }
                            playerLoader.classList.add('hidden');
                            return; // Exit successfully!
                        } catch (err) {
                            console.warn(`[Player] Candidate ${candidateName} failed:`, err.message);
                        }
                    }
                } catch (err) {
                    console.warn(`[Player] Method ${method.name} failed:`, err.message);
                }
            }
            
            // If all methods failed
            isNativeFailoverActive = false;
            if (requestId !== currentStreamRequestId) return;

            if (lastResortIframeUrl) {
                // We have a saved iframe URL (e.g. Blogger) — load it directly
                debugLog(`[Player] All native methods failed. Using last resort iframe URL: ${lastResortIframeUrl.substring(0, 80)}`);
                showToast('Reproduzindo via player alternativo...');
                if (playerCustomFullscreenBtn) playerCustomFullscreenBtn.classList.remove('hidden');
                playerIframe.src = lastResortIframeUrl;
                playerLoader.classList.add('hidden');
            } else {
                debugLog('[Player] All native and fallback resolvers returned no streams for this episode.');
                showToast('Este episódio não está disponível ou ainda não foi lançado nos servidores.');
                playerSubtitle.textContent = 'Episódio indisponível no momento.';
                playerLoader.classList.add('hidden');
            }
        })();
        return;
    }
    
    debugLog(`Loading stream URL via key: ${providerKey} - ${url}`);
    playerIframe.src = url;
    
    // Trigger check for intros if it's a TV series/anime
    if (currentOpenItem.type === 'tv') {
        checkIntroTimestamps(id, currentEpisodeState.season, currentEpisodeState.episode);
    }
    
    playerSubtitle.textContent = currentOpenItem.type === 'movie' 
        ? `Filme Completo • Servidor: ${provider.name}` 
        : `T${currentEpisodeState.season}:Ep${currentEpisodeState.episode} • Servidor: ${provider.name}`;
}

// Helper to configure native HTML5 or Hls.js streams in our customized player.
// Deliberately does NOT reveal the <video> element or start playback — the
// source loads while still hidden so we can validate it (see the
// 'loadedmetadata' duration check in loadPlayerStream) before showing so much
// as a single frame to the user. Call revealNativePlayer() once validated.
function initializeNativePlayer(directUrl) {
    if (playerNative) {
        // Track currently active stream source URL
        currentPlayingUrl = new URL(directUrl, window.location.href).href;
        
        // Reset time/progress/quality UI BEFORE loading the new source. This must
        // happen here and not in revealNativePlayer(): the permanent 'loadedmetadata'
        // listener (which sets nativeTimeTotal to the real duration) fires the
        // instant the source loads, and revealNativePlayer() only runs afterwards
        // (once the duration check passes) — resetting there would wipe out the
        // real duration it just set.
        if (nativeTimeCurrent) nativeTimeCurrent.textContent = '00:00';
        if (nativeTimeTotal) nativeTimeTotal.textContent = '00:00';
        if (nativeTimelineProgress) nativeTimelineProgress.style.width = '0%';
        if (nativeTimelineBuffered) nativeTimelineBuffered.style.width = '0%';
        // Reset quality selector — will be re-shown by setupQualityLevels() once manifest is parsed
        currentQualityLevelIndex = -1;
        if (nativeQualityLabel) nativeQualityLabel.textContent = 'Auto';
        if (nativeQualityMenu) nativeQualityMenu.innerHTML = '';
        if (nativeQualityMenu) nativeQualityMenu.classList.add('hidden');
        if (nativeQualityWrapper) nativeQualityWrapper.classList.add('hidden');
        if (nativeAudioLabel) nativeAudioLabel.textContent = currentAudioPreference === 'dubbed' ? 'Dublado' : 'Legendado';
        if (nativeAudioMenu) nativeAudioMenu.innerHTML = '';
        if (nativeAudioMenu) nativeAudioMenu.classList.add('hidden');
        if (currentAudioPreference === 'subtitled') {
            if (nativeSubtitleWrapper) nativeSubtitleWrapper.classList.remove('hidden');
            fetchExternalSubtitles();
        } else {
            if (nativeSubtitleWrapper) nativeSubtitleWrapper.classList.add('hidden');
            if (nativeSubtitleMenu) nativeSubtitleMenu.classList.add('hidden');
        }
        if (nativeSkipIntroBtn) nativeSkipIntroBtn.style.display = 'none';
        // Reset zoom/fill mode back to 'contain' on every new source — the need for
        // cropping varies per provider/source, so it should never carry over between videos.
        isZoomFillActive = false;
        if (playerNative) {
            playerNative.classList.remove('object-cover');
            playerNative.classList.add('object-contain');
        }
        if (nativeZoomBtn) {
            const zoomIcon = nativeZoomBtn.querySelector('i');
            if (zoomIcon) {
                zoomIcon.classList.remove('fa-down-left-and-up-right-to-center');
                zoomIcon.classList.add('fa-up-right-and-down-left-from-center');
            }
            nativeZoomBtn.title = 'Preencher Tela';
        }
        
        // Check if stream is HLS (M3U8)
        if (directUrl.includes('.m3u8') || directUrl.includes('/hls/')) {
            if (window.Hls && Hls.isSupported()) {
                if (hlsInstance) {
                    hlsInstance.destroy();
                }
                
                // Custom loader to intercept and proxy external segments/assets to prevent CORS block
                class CustomHlsLoader extends Hls.DefaultConfig.loader {
                    constructor(config) {
                        super(config);
                        const load = this.load.bind(this);
                        this.load = function (context, config, callbacks) {
                            let url = context.url;
                            if (url.startsWith('//')) {
                                url = window.location.protocol + url;
                            }
                            if (url.startsWith('http') && !url.includes(window.location.host) && !url.includes('/dynamic-proxy/')) {
                                const originalUrl = url;
                                const urlObj = new URL(url);
                                context.url = `/dynamic-proxy/${urlObj.host}${urlObj.pathname}${urlObj.search}`;
                                debugLog(`[Player] Proxied external HLS asset from ${originalUrl} to ${context.url}`);
                            }
                            load(context, config, callbacks);
                        };
                    }
                }

                hlsInstance = new Hls({
                    maxMaxBufferLength: 30,
                    pLoader: CustomHlsLoader,
                    fLoader: CustomHlsLoader
                });
                hlsInstance.loadSource(directUrl);
                hlsInstance.attachMedia(playerNative);
                hlsInstance.on(Hls.Events.ERROR, (event, data) => {
                    console.error('[Player] HlsInstance error event:', data);
                    if (data && data.fatal && playerNative) {
                        playerNative.dispatchEvent(new Event('error'));
                    }
                });
                // Once the manifest is parsed, we know all available quality levels (renditions)
                hlsInstance.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
                    setupQualityLevels(data.levels);
                });
                // Keep the "Auto" label in sync with the level ABR actually picks
                hlsInstance.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
                    updateQualityLabel(data.level);
                });
                // Some manifests (e.g. EmbedMovies for certain anime titles like Black
                // Clover) expose the dubbed Portuguese audio as an alternate EXT-X-MEDIA
                // AUDIO track with DEFAULT=NO — hls.js otherwise keeps whatever track the
                // manifest marks as default (often the original/Japanese one muxed into
                // the video segments). Explicitly switch to the best-matching Portuguese
                // track as soon as the track list is known, so dubbed audio plays without
                // requiring the user to open the audio menu manually.
                hlsInstance.on(Hls.Events.AUDIO_TRACKS_UPDATED, (event, data) => {
                    const tracks = data.audioTracks || [];
                    renderAudioMenu(tracks);

                    if (tracks.length > 1) {
                        if (currentAudioPreference === 'dubbed') {
                            const ptTrackIndex = tracks.findIndex((track) => {
                                const lang = (track.lang || '').toLowerCase();
                                const name = (track.name || '').toLowerCase();
                                return lang.startsWith('por') || name.includes('portug') || name.includes('dublad');
                            });
                            if (ptTrackIndex !== -1) {
                                debugLog(`[Player] Switching to Portuguese audio track (index ${ptTrackIndex}):`, tracks[ptTrackIndex].name);
                                hlsInstance.audioTrack = ptTrackIndex;
                            }
                        } else if (currentAudioPreference === 'subtitled') {
                            let origTrackIndex = tracks.findIndex((track) => {
                                const lang = (track.lang || '').toLowerCase();
                                const name = (track.name || '').toLowerCase();
                                return lang.startsWith('eng') || lang.startsWith('jpn') || lang.startsWith('jap') || name.includes('eng') || name.includes('ingl') || name.includes('orig') || name.includes('jap');
                            });
                            if (origTrackIndex === -1) {
                                origTrackIndex = tracks.findIndex((track) => {
                                    const lang = (track.lang || '').toLowerCase();
                                    const name = (track.name || '').toLowerCase();
                                    return !lang.startsWith('por') && !name.includes('portug') && !name.includes('dublad');
                                });
                            }
                            if (origTrackIndex !== -1) {
                                debugLog(`[Player] Switching to Original/Subtitled audio track (index ${origTrackIndex}):`, tracks[origTrackIndex].name);
                                hlsInstance.audioTrack = origTrackIndex;
                            }
                        }
                    }
                });
                debugLog('[Player] Hls.js initialized for native playback:', directUrl);
            } else if (playerNative.canPlayType('application/vnd.apple.mpegurl')) {
                playerNative.src = directUrl;
                debugLog('[Player] Safari native HLS playback initialized:', directUrl);
            } else {
                playerNative.src = directUrl;
                console.warn('[Player] Hls.js not supported. Fallback direct bind.');
            }
        } else {
            // Standard direct video file (e.g. mp4, webm)
            if (hlsInstance) {
                hlsInstance.destroy();
                hlsInstance = null;
            }
            playerNative.src = directUrl;
            debugLog('[Player] Native direct MP4 playback initialized:', directUrl);
        }
    }
}

// Reveals the (already-loaded and duration-validated) native player and starts
// playback. Split out from initializeNativePlayer so the placeholder/offline
// clip a provider like ClickHost may return never flashes on screen — this is
// only called once the 'loadedmetadata' duration check has passed.
function revealNativePlayer() {
    if (!playerNative) return;

    playerIframe.classList.add('hidden');
    playerOverlayControls.classList.add('hidden'); // Hide iframe controls overlay
    if (playerCustomFullscreenBtn) playerCustomFullscreenBtn.classList.add('hidden');
    playerNative.classList.remove('hidden');

    // Show custom native player controls
    if (playerNativeControls) {
        playerNativeControls.classList.remove('hidden');
        playerNativeControls.classList.remove('opacity-0');
        playerNativeControls.classList.add('opacity-100');
        
        if (currentOpenItem.type === 'tv') {
            if (nativeTvControls) nativeTvControls.classList.remove('hidden');
            if (nativeTvControlsPrev) nativeTvControlsPrev.classList.remove('hidden');
        } else {
            if (nativeTvControls) nativeTvControls.classList.add('hidden');
            if (nativeTvControlsPrev) nativeTvControlsPrev.classList.add('hidden');
        }
        
        // Reset controls UI (play/pause icon only — time/quality already reset in initializeNativePlayer)
        if (nativePlayBtn) nativePlayBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
        if (nativeCenterPlayBtn) {
            nativeCenterPlayBtn.innerHTML = '<i class="fa-solid fa-play text-3xl ml-1"></i>';
            nativeCenterPlayBtn.classList.remove('opacity-100', 'scale-100');
            nativeCenterPlayBtn.classList.add('opacity-0', 'scale-75');
        }
        renderAudioMenu();
    }
    
    playerSubtitle.textContent = currentOpenItem.type === 'movie' 
        ? `Filme Completo • Player Principal` 
        : `T${currentEpisodeState.season}:Ep${currentEpisodeState.episode} • Player Principal`;
        
    playerNative.play().catch(e => {
        console.warn('Native video autoplay was prevented. Waiting for user interaction:', e);
    });
}

// Builds the quality selector menu from the HLS levels detected in the manifest.
// Only shown when the stream actually offers more than one rendition/resolution;
// single-rendition HLS streams and direct MP4 files never display this control.
function setupQualityLevels(levels) {
    if (!nativeQualityMenu || !nativeQualityWrapper) return;
    if (!levels || levels.length <= 1) {
        nativeQualityWrapper.classList.add('hidden');
        return;
    }

    // Sort from highest to lowest resolution for a natural top-to-bottom list
    const sortedIndexes = levels
        .map((level, index) => ({ index, height: level.height || 0 }))
        .sort((a, b) => b.height - a.height);

    nativeQualityMenu.innerHTML = '';

    const createOption = (levelIndex, label) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.levelIndex = String(levelIndex);
        btn.className = 'quality-option w-full text-left px-3.5 py-2 text-xs font-semibold text-textSec hover:text-white hover:bg-white/10 transition-colors duration-150 flex items-center justify-between';
        btn.innerHTML = `<span>${label}</span>`;
        btn.addEventListener('click', () => selectQualityLevel(levelIndex));
        return btn;
    };

    // "Automática" lets Hls.js's ABR algorithm keep switching levels based on bandwidth
    nativeQualityMenu.appendChild(createOption(-1, 'Automática'));
    sortedIndexes.forEach(({ index, height }) => {
        nativeQualityMenu.appendChild(createOption(index, height ? `${height}p` : `Nível ${index + 1}`));
    });

    nativeQualityWrapper.classList.remove('hidden');
    currentQualityLevelIndex = -1; // Every new manifest starts back in Automatic mode
    updateQualityLabel(hlsInstance ? hlsInstance.currentLevel : -1);
}

// Applies the user's manually chosen quality level to the active Hls.js instance.
// Passing -1 restores Automatic (ABR) mode.
function selectQualityLevel(levelIndex) {
    if (!hlsInstance) return;
    currentQualityLevelIndex = levelIndex;
    hlsInstance.currentLevel = levelIndex;
    updateQualityLabel(levelIndex);
    if (nativeQualityMenu) nativeQualityMenu.classList.add('hidden');
    showToast(levelIndex === -1 ? '🎚️ Qualidade: Automática' : '🎚️ Qualidade alterada');
}

// Updates the button label (e.g. "Auto (720p)" or "1080p") and the checkmark
// on the active menu item. Called on manual selection and on every ABR switch.
function updateQualityLabel(activeLevelIndex) {
    if (!nativeQualityLabel || !hlsInstance || !hlsInstance.levels) return;

    if (currentQualityLevelIndex === -1) {
        const level = hlsInstance.levels[activeLevelIndex];
        nativeQualityLabel.textContent = level && level.height ? `${level.height}p` : 'Auto';
    } else {
        const level = hlsInstance.levels[currentQualityLevelIndex];
        nativeQualityLabel.textContent = level && level.height ? `${level.height}p` : 'Manual';
    }

    if (nativeQualityMenu) {
        nativeQualityMenu.querySelectorAll('.quality-option').forEach(btn => {
            const idx = parseInt(btn.dataset.levelIndex, 10);
            const isActive = idx === currentQualityLevelIndex;
            btn.classList.toggle('bg-brand/20', isActive);
            btn.classList.toggle('text-white', isActive);
            btn.classList.toggle('text-textSec', !isActive);
            const existingCheck = btn.querySelector('.fa-check');
            if (isActive && !existingCheck) {
                btn.insertAdjacentHTML('beforeend', '<i class="fa-solid fa-check text-[10px]"></i>');
            } else if (!isActive && existingCheck) {
                existingCheck.remove();
            }
        });
    }
}

let currentAudioPreference = 'dubbed'; // 'dubbed' or 'subtitled'

// Renders the audio selector menu on the native player control bar.
function renderAudioMenu(hlsTracks = []) {
    if (!nativeAudioMenu || !nativeAudioWrapper) return;
    nativeAudioMenu.innerHTML = '';
    
    // Header section: Idioma do Conteúdo
    const prefTitle = document.createElement('div');
    prefTitle.className = 'px-3 py-1 text-[10px] uppercase font-bold text-textSec/70 tracking-wider';
    prefTitle.textContent = 'Idioma do Vídeo';
    nativeAudioMenu.appendChild(prefTitle);

    // Option 1: Dublado
    const dubBtn = document.createElement('button');
    dubBtn.type = 'button';
    dubBtn.className = `audio-option w-full text-left px-3.5 py-2 text-xs font-semibold ${currentAudioPreference === 'dubbed' ? 'bg-brand/20 text-white' : 'text-textSec hover:text-white hover:bg-white/10'} transition-colors duration-150 flex items-center justify-between cursor-pointer`;
    dubBtn.innerHTML = `<span>🎧 Dublado (Português)</span>${currentAudioPreference === 'dubbed' ? '<i class="fa-solid fa-check text-[10px]"></i>' : ''}`;
    dubBtn.onclick = () => switchAudioPreference('dubbed');
    nativeAudioMenu.appendChild(dubBtn);

    // Option 2: Legendado
    const subBtn = document.createElement('button');
    subBtn.type = 'button';
    subBtn.className = `audio-option w-full text-left px-3.5 py-2 text-xs font-semibold ${currentAudioPreference === 'subtitled' ? 'bg-brand/20 text-white' : 'text-textSec hover:text-white hover:bg-white/10'} transition-colors duration-150 flex items-center justify-between cursor-pointer`;
    subBtn.innerHTML = `<span>💬 Legendado (Original)</span>${currentAudioPreference === 'subtitled' ? '<i class="fa-solid fa-check text-[10px]"></i>' : ''}`;
    subBtn.onclick = () => switchAudioPreference('subtitled');
    nativeAudioMenu.appendChild(subBtn);

    // If HLS embedded tracks exist, list them too
    if (hlsTracks && hlsTracks.length > 1) {
        const divider = document.createElement('div');
        divider.className = 'my-1 border-t border-white/10';
        nativeAudioMenu.appendChild(divider);

        const tracksTitle = document.createElement('div');
        tracksTitle.className = 'px-3 py-1 text-[10px] uppercase font-bold text-textSec/70 tracking-wider';
        tracksTitle.textContent = 'Trilhas HLS Embutidas';
        nativeAudioMenu.appendChild(tracksTitle);

        hlsTracks.forEach((track, index) => {
            const btn = document.createElement('button');
            const lang = (track.lang || '').toLowerCase();
            const name = (track.name || '').trim();
            let label = name || `Faixa ${index + 1}`;
            if (lang.startsWith('por') || name.toLowerCase().includes('portug') || name.toLowerCase().includes('dublad')) {
                label = 'Português (Dublado)';
            } else if (lang.startsWith('jpn') || lang.startsWith('jap') || name.toLowerCase().includes('jap') || name.toLowerCase().includes('orig')) {
                label = 'Japonês (Original)';
            } else if (lang.startsWith('eng') || name.toLowerCase().includes('ingl')) {
                label = 'Inglês';
            }
            const isActive = hlsInstance && hlsInstance.audioTrack === index;
            btn.type = 'button';
            btn.className = `audio-option w-full text-left px-3.5 py-2 text-xs font-semibold ${isActive ? 'bg-brand/20 text-white' : 'text-textSec hover:text-white hover:bg-white/10'} transition-colors duration-150 flex items-center justify-between cursor-pointer`;
            btn.innerHTML = `<span>${escapeHtml(label)}</span>${isActive ? '<i class="fa-solid fa-check text-[10px]"></i>' : ''}`;
            btn.onclick = () => selectHlsAudioTrack(index, label);
            nativeAudioMenu.appendChild(btn);
        });
    }

    nativeAudioWrapper.classList.remove('hidden');
    if (nativeAudioLabel) {
        nativeAudioLabel.textContent = currentAudioPreference === 'dubbed' ? 'Dublado' : 'Legendado';
    }
}

function switchAudioPreference(pref) {
    if (currentAudioPreference === pref) {
        if (nativeAudioMenu) nativeAudioMenu.classList.add('hidden');
        return;
    }
    currentAudioPreference = pref;
    if (nativeAudioMenu) nativeAudioMenu.classList.add('hidden');
    if (pref === 'subtitled') {
        if (nativeSubtitleWrapper) nativeSubtitleWrapper.classList.remove('hidden');
        fetchExternalSubtitles();
    } else {
        if (nativeSubtitleWrapper) nativeSubtitleWrapper.classList.add('hidden');
        if (nativeSubtitleMenu) nativeSubtitleMenu.classList.add('hidden');
    }
    showToast(pref === 'dubbed' ? '🎧 Carregando versão Dublada...' : '💬 Carregando versão Legendada...');
    loadPlayerStream();
}

// -----------------------------------------------------------------------------
// SUBTITLE MANAGEMENT & SYNCHRONIZATION
// -----------------------------------------------------------------------------
let availableSubtitleTracks = [];
let activeSubtitleTrackId = 'none'; // 'none' or track url
let subtitleSyncOffsetSeconds = 0.0;
let originalSubtitleCues = []; // Stores original cue start/end times for lossless sync adjustment

async function fetchExternalSubtitles() {
    availableSubtitleTracks = [];
    activeSubtitleTrackId = 'none';
    if (playerNative) {
        const oldTracks = playerNative.querySelectorAll('track');
        oldTracks.forEach(t => t.remove());
    }
    if (nativeSubtitleLabel) nativeSubtitleLabel.textContent = 'Legenda';
    renderSubtitleMenu();

    if (!currentOpenItem || currentAudioPreference !== 'subtitled') return;
    try {
        const params = new URLSearchParams({
            mediaType: currentOpenItem.type === 'movie' ? 'movie' : 'tv',
            tmdbId: String(currentOpenItem.id)
        });
        if (currentOpenItem.imdbId) params.set('imdbId', currentOpenItem.imdbId);
        if (currentEpisodeState && currentEpisodeState.season != null) {
            params.set('season', String(currentEpisodeState.season));
            params.set('episode', String(currentEpisodeState.episode));
        }
        const res = await fetch(`/api/subtitles/list?${params.toString()}`);
        if (res.ok) {
            const data = await res.json();
            if (data.ok && Array.isArray(data.subtitles)) {
                availableSubtitleTracks = data.subtitles;
            }
        }
    } catch (e) {
        console.warn('[Subtitles] Failed to fetch external subtitles:', e);
    } finally {
        renderSubtitleMenu();
    }
}

function renderSubtitleMenu() {
    if (!nativeSubtitleMenu || !nativeSubtitleWrapper) return;
    if (currentAudioPreference !== 'subtitled') {
        nativeSubtitleWrapper.classList.add('hidden');
        nativeSubtitleMenu.classList.add('hidden');
        return;
    }
    nativeSubtitleWrapper.classList.remove('hidden');
    nativeSubtitleMenu.innerHTML = '';

    // Section 1: Faixas de Legenda
    const titleEl = document.createElement('div');
    titleEl.className = 'px-3 py-1 text-[10px] uppercase font-bold text-textSec/70 tracking-wider';
    titleEl.textContent = 'Legendas';
    nativeSubtitleMenu.appendChild(titleEl);

    // Option: Desativada
    const offBtn = document.createElement('button');
    offBtn.type = 'button';
    const isOff = activeSubtitleTrackId === 'none';
    offBtn.className = `sub-option w-full text-left px-3.5 py-2 text-xs font-semibold ${isOff ? 'bg-brand/20 text-white' : 'text-textSec hover:text-white hover:bg-white/10'} transition-colors duration-150 flex items-center justify-between cursor-pointer`;
    offBtn.innerHTML = `<span>🚫 Desativada</span>${isOff ? '<i class="fa-solid fa-check text-[10px]"></i>' : ''}`;
    offBtn.onclick = () => selectSubtitleTrack('none');
    nativeSubtitleMenu.appendChild(offBtn);

    // Subtitle Tracks from Server
    if (availableSubtitleTracks && availableSubtitleTracks.length > 0) {
        availableSubtitleTracks.forEach((track) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            const isActive = activeSubtitleTrackId === track.url;
            btn.className = `sub-option w-full text-left px-3.5 py-2 text-xs font-semibold ${isActive ? 'bg-brand/20 text-white' : 'text-textSec hover:text-white hover:bg-white/10'} transition-colors duration-150 flex items-center justify-between cursor-pointer`;
            btn.innerHTML = `<span>💬 ${escapeHtml(track.label)}</span>${isActive ? '<i class="fa-solid fa-check text-[10px]"></i>' : ''}`;
            btn.onclick = () => selectSubtitleTrack(track.url, track.label);
            nativeSubtitleMenu.appendChild(btn);
        });
    } else {
        const emptyEl = document.createElement('div');
        emptyEl.className = 'px-3.5 py-1.5 text-[11px] text-textSec/60 italic';
        emptyEl.textContent = 'Buscando legendas...';
        nativeSubtitleMenu.appendChild(emptyEl);
    }

    // Section 2: Sincronização de Tempo
    const divider = document.createElement('div');
    divider.className = 'my-1.5 border-t border-white/10';
    nativeSubtitleMenu.appendChild(divider);

    const syncTitle = document.createElement('div');
    syncTitle.className = 'px-3 py-1 text-[10px] uppercase font-bold text-textSec/70 tracking-wider flex items-center justify-between';
    const offsetLabel = subtitleSyncOffsetSeconds === 0 
        ? '0.0s (Normal)' 
        : `${subtitleSyncOffsetSeconds > 0 ? '+' : ''}${subtitleSyncOffsetSeconds.toFixed(1)}s`;
    syncTitle.innerHTML = `<span>⏱️ Sincronia</span><span class="text-brand font-mono">${offsetLabel}</span>`;
    nativeSubtitleMenu.appendChild(syncTitle);

    const syncControls = document.createElement('div');
    syncControls.className = 'px-3 py-1.5 flex flex-col gap-1.5';
    syncControls.innerHTML = `
        <div class="grid grid-cols-7 gap-1">
            <button type="button" class="sub-sync-btn py-1 bg-white/5 hover:bg-white/15 text-white text-[10px] font-bold rounded" title="Atrasar 3s">-3s</button>
            <button type="button" class="sub-sync-btn py-1 bg-white/5 hover:bg-white/15 text-white text-[10px] font-bold rounded" title="Atrasar 1s">-1s</button>
            <button type="button" class="sub-sync-btn py-1 bg-white/5 hover:bg-white/15 text-white text-[10px] font-bold rounded" title="Atrasar 0.5s">-0.5s</button>
            <button type="button" class="sub-sync-btn py-1 bg-brand/30 hover:bg-brand/50 text-white text-[10px] font-bold rounded" title="Resetar">0s</button>
            <button type="button" class="sub-sync-btn py-1 bg-white/5 hover:bg-white/15 text-white text-[10px] font-bold rounded" title="Adiantar 0.5s">+0.5s</button>
            <button type="button" class="sub-sync-btn py-1 bg-white/5 hover:bg-white/15 text-white text-[10px] font-bold rounded" title="Adiantar 1s">+1s</button>
            <button type="button" class="sub-sync-btn py-1 bg-white/5 hover:bg-white/15 text-white text-[10px] font-bold rounded" title="Adiantar 3s">+3s</button>
        </div>
        <div class="text-[9px] text-textSec/50 text-center italic">Teclas: <span class="font-mono text-white/80">G</span> (atrasar) | <span class="font-mono text-white/80">H</span> (adiantar) | <span class="font-mono text-white/80">J</span> (reset)</div>
    `;
    
    const btns = syncControls.querySelectorAll('.sub-sync-btn');
    btns[0].onclick = (e) => { e.stopPropagation(); adjustSubtitleSync(-3.0); };
    btns[1].onclick = (e) => { e.stopPropagation(); adjustSubtitleSync(-1.0); };
    btns[2].onclick = (e) => { e.stopPropagation(); adjustSubtitleSync(-0.5); };
    btns[3].onclick = (e) => { e.stopPropagation(); resetSubtitleSync(); };
    btns[4].onclick = (e) => { e.stopPropagation(); adjustSubtitleSync(0.5); };
    btns[5].onclick = (e) => { e.stopPropagation(); adjustSubtitleSync(1.0); };
    btns[6].onclick = (e) => { e.stopPropagation(); adjustSubtitleSync(3.0); };

    nativeSubtitleMenu.appendChild(syncControls);

    if (nativeSubtitleLabel) {
        nativeSubtitleLabel.textContent = activeSubtitleTrackId !== 'none' ? 'Legenda [ON]' : 'Legenda';
    }
}

async function selectSubtitleTrack(trackUrl, label = 'Português', silent = false) {
    activeSubtitleTrackId = trackUrl;
    subtitleSyncOffsetSeconds = 0.0;
    originalSubtitleCues = [];

    // Remove existing track elements
    if (playerNative) {
        const oldTracks = playerNative.querySelectorAll('track');
        oldTracks.forEach(t => t.remove());
    }

    if (trackUrl === 'none') {
        if (nativeSubtitleLabel) nativeSubtitleLabel.textContent = 'Legenda';
        renderSubtitleMenu();
        if (!silent) showToast('💬 Legenda desativada');
        return;
    }

    if (nativeSubtitleLabel) nativeSubtitleLabel.textContent = 'Legenda [ON]';
    renderSubtitleMenu();
    if (!silent) showToast(`💬 Carregando legenda ${label}...`);

    try {
        const proxiedSubUrl = `/api/subtitles/file?url=${encodeURIComponent(trackUrl)}`;
        const res = await fetch(proxiedSubUrl);
        if (!res.ok) throw new Error('Falha ao baixar arquivo de legenda');
        
        const vttText = await res.text();
        const blob = new Blob([vttText], { type: 'text/vtt;charset=utf-8' });
        const blobUrl = URL.createObjectURL(blob);

        const trackEl = document.createElement('track');
        trackEl.kind = 'subtitles';
        trackEl.label = label;
        trackEl.srclang = 'pt';
        trackEl.src = blobUrl;
        trackEl.default = true;

        playerNative.appendChild(trackEl);
        
        setTimeout(() => {
            if (playerNative.textTracks && playerNative.textTracks.length > 0) {
                for (let i = 0; i < playerNative.textTracks.length; i++) {
                    playerNative.textTracks[i].mode = (i === playerNative.textTracks.length - 1) ? 'showing' : 'disabled';
                }
                cacheOriginalSubtitleCues();
            }
        }, 300);

        if (!silent) showToast(`💬 Legenda ${label} ativada!`);
    } catch (err) {
        console.error('[Subtitles] Error attaching track:', err);
        if (!silent) showToast('⚠️ Não foi possível carregar a legenda');
    }
}

function cacheOriginalSubtitleCues() {
    originalSubtitleCues = [];
    if (!playerNative || !playerNative.textTracks || playerNative.textTracks.length === 0) return;
    const track = playerNative.textTracks[playerNative.textTracks.length - 1];
    if (!track || !track.cues) return;
    for (let i = 0; i < track.cues.length; i++) {
        const cue = track.cues[i];
        originalSubtitleCues.push({ startTime: cue.startTime, endTime: cue.endTime });
    }
}
 
function adjustSubtitleSync(delta) {
    subtitleSyncOffsetSeconds += delta;
    applySubtitleSync();
}

function resetSubtitleSync() {
    subtitleSyncOffsetSeconds = 0.0;
    applySubtitleSync();
}

function applySubtitleSync() {
    if (!playerNative || !playerNative.textTracks || playerNative.textTracks.length === 0) return;
    const track = playerNative.textTracks[playerNative.textTracks.length - 1];
    if (!track || !track.cues) return;

    if (originalSubtitleCues.length !== track.cues.length) {
        cacheOriginalSubtitleCues();
    }

    for (let i = 0; i < track.cues.length; i++) {
        const cue = track.cues[i];
        const orig = originalSubtitleCues[i];
        if (orig) {
            cue.startTime = Math.max(0, orig.startTime + subtitleSyncOffsetSeconds);
            cue.endTime = Math.max(0, orig.endTime + subtitleSyncOffsetSeconds);
        }
    }

    const offsetText = subtitleSyncOffsetSeconds === 0 
        ? '0.0s (Normal)' 
        : `${subtitleSyncOffsetSeconds > 0 ? '+' : ''}${subtitleSyncOffsetSeconds.toFixed(1)}s`;
    showToast(`⏱️ Sincronia da Legenda: ${offsetText}`);
    renderSubtitleMenu();
}

function selectHlsAudioTrack(trackIndex, label) {
    if (!hlsInstance) return;
    hlsInstance.audioTrack = trackIndex;
    if (nativeAudioMenu) nativeAudioMenu.classList.add('hidden');
    showToast(label ? `🔊 Áudio: ${label}` : '🔊 Faixa de áudio alterada');
    renderAudioMenu(hlsInstance.audioTracks);
}

// Resolves via the backend's /best-stream-resolve endpoint — the SAME parallel
// resolver the mobile app uses (mobile/lib/api/player.ts's
// resolveBestAvailableStream): it runs MegaEmbed + EmbedMovies + ClickHost
// simultaneously server-side (see resolveBestStream in
// server/app-middleware.js) and returns whichever one actually has dubbed
// Portuguese audio, and among ties, the highest measured quality
// (bits-per-pixel). This is the "same technique as the apps" the web player
// was missing — it used to only ever try MegaEmbed, then EmbedMovies, then
// ClickHost sequentially and stop at the first one that merely WORKED,
// regardless of whether a later provider in that list would have been
// dubbed/higher quality. Returns null (never throws) so the caller's existing
// sequential methods array is used as an automatic fallback if this parallel
// path fails outright or the resolved URL doesn't actually play (handled by
// loadPlayerStream's existing per-method validation/timeout logic below).
async function resolveBestAvailableStream(mediaType, tmdbId, imdbId, season, episode) {
    try {
        const params = new URLSearchParams({
            mediaType,
            tmdbId: String(tmdbId),
            hq: '0',
            dubbed: currentAudioPreference === 'dubbed' ? '1' : '0',
            _t: String(Date.now())
        });
        if (imdbId) params.set('imdbId', imdbId);
        if (season != null) params.set('season', String(season));
        if (episode != null) params.set('episode', String(episode));

        const resolverUrl = `/best-stream-resolve?${params.toString()}`;
        debugLog(`[BestStream] Resolving via parallel dubbed/quality resolver: ${resolverUrl}`);
        const response = await fetch(resolverUrl, { cache: 'no-cache' });
        if (!response.ok) return null;

        const data = await response.json();
        if (!data.ok || !data.url) return null;

        debugLog(`[BestStream] Chose ${data.provider} (dubbed=${data.dubbed}, quality=${(data.quality || 0).toFixed(3)}): ${data.url}`);
        return {
            url: data.url,
            candidates: data.candidates && Array.isArray(data.candidates) ? data.candidates : [{ url: data.url, provider: data.provider }]
        };
    } catch (err) {
        return null;
    }
}

// Helper to resolve EmbedMovies (myembed.biz) to direct .m3u8 link via backend
async function resolveEmbedMoviesStream(url) {
    try {
        const urlObj = new URL(url, window.location.origin);
        const path = urlObj.pathname + urlObj.search;
        const resolverUrl = `/embedmovies-resolve${path}`;
        debugLog(`[EmbedMovies] Resolving stream via backend: ${resolverUrl}`);

        const response = await fetch(resolverUrl);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

        const data = await response.json();
        if (!data.ok || !data.url) throw new Error(data.error || 'Failed to resolve stream');

        debugLog(`[EmbedMovies] Resolved direct stream URL via backend (${data.type}): ${data.url}`);
        return data.url;
    } catch (err) {
        console.error('[EmbedMovies] Stream resolver failed:', err);
        return null;
    }
}


// Helper to resolve ClickHost embed pages to direct video links using local Vite proxy
async function resolveClickHostStream(url) {
    try {
        const path = new URL(url).pathname;
        const resolverUrl = `/clickhost-resolve${path}`;
        
        debugLog(`[ClickHost] Resolving stream via backend cycletls: ${resolverUrl}`);
        const response = await fetch(resolverUrl);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        
        const data = await response.json();
        if (!data.ok || !data.url) throw new Error(data.error || 'Failed to resolve stream');
        
        debugLog(`[ClickHost] Resolved direct stream URL via backend: ${data.url}`);
        return data.url;
    } catch (err) {
        console.error('[ClickHost] Stream resolver failed:', err);
        return null;
    }
}

// Helper to resolve FenixFlix (Stremio Addon) to direct video links using backend
async function resolveFenixFlixStream(mediaType, tmdbId, imdbId, season, episode) {
    try {
        const params = new URLSearchParams({
            mediaType,
            tmdbId: String(tmdbId),
            dubbed: currentAudioPreference === 'dubbed' ? '1' : '0'
        });
        if (imdbId) params.set('imdbId', imdbId);
        if (season != null) params.set('season', String(season));
        if (episode != null) params.set('episode', String(episode));

        const resolverUrl = `/fenixflix-resolve?${params.toString()}`;
        debugLog(`[FenixFlix] Resolving stream via backend: ${resolverUrl}`);
        const response = await fetch(resolverUrl);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

        const data = await response.json();
        if (!data.ok || !data.url) throw new Error(data.error || 'Failed to resolve stream');

        debugLog(`[FenixFlix] Resolved direct stream URL via backend (${data.type}): ${data.url}`);
        return data.url;
    } catch (err) {
        console.error('[FenixFlix] Stream resolver failed:', err);
        return null;
    }
}

// Helper to resolve MegaEmbed (mgeb.top) embed pages to direct video links using local Vite backend
async function resolveMegaEmbedStream(url) {
    try {
        const path = new URL(url).pathname;
        const resolverUrl = `/megaembed-resolve${path}`;

        debugLog(`[MegaEmbed] Resolving stream via backend: ${resolverUrl}`);
        const response = await fetch(resolverUrl);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

        const data = await response.json();
        if (!data.ok || !data.url) throw new Error(data.error || 'Failed to resolve stream');

        debugLog(`[MegaEmbed] Resolved direct stream URL via backend (${data.type}): ${data.url}`);
        return data.url;
    } catch (err) {
        console.error('[MegaEmbed] Stream resolver failed:', err);
        return null;
    }
}

// Helper to resolve AnimeFire (Dedicated Anime) to direct video links using backend
async function resolveAnimeFireStream(mediaType, tmdbId, imdbId, season, episode, title) {
    return null;
}

// Populate Seasons and Episodes dynamically using TMDB endpoints
async function populateEpisodeSelectors(tmdbId, selectedSeason, selectedEpisode) {
    const data = await fetchFromTMDB(`/tv/${tmdbId}`);
    if (!data) return;

    // Reset Season selector
    playerSeasonSelect.innerHTML = '';
    
    if (data.seasons && data.seasons.length > 0) {
        data.seasons.forEach(s => {
            // Exclude season 0 (Specials) if preferred
            if (s.season_number > 0) {
                const opt = document.createElement('option');
                opt.value = s.season_number;
                opt.textContent = `Temporada ${s.season_number}`;
                if (s.season_number === selectedSeason) opt.selected = true;
                playerSeasonSelect.appendChild(opt);
            }
        });
    }

    // Fetch episodes for initial/selected season
    await loadEpisodeList(tmdbId, selectedSeason, selectedEpisode);

    // Event listener change triggers re-fetching episode mappings
    playerSeasonSelect.onchange = async (e) => {
        const nextSeason = parseInt(e.target.value);
        currentEpisodeState.season = nextSeason;
        currentEpisodeState.episode = 1;
        await loadEpisodeList(tmdbId, nextSeason, 1);
        loadPlayerStream();
    };

    playerEpisodeSelect.onchange = (e) => {
        const nextEpisode = parseInt(e.target.value);
        currentEpisodeState.episode = nextEpisode;
        loadPlayerStream();
    };
}

async function loadEpisodeList(tmdbId, seasonNumber, selectedEpisode) {
    playerEpisodeSelect.innerHTML = '';
    const seasonData = await fetchFromTMDB(`/tv/${tmdbId}/season/${seasonNumber}`);
    
    if (seasonData && seasonData.episodes && seasonData.episodes.length > 0) {
        seasonData.episodes.forEach(ep => {
            const opt = document.createElement('option');
            opt.value = ep.episode_number;
            opt.textContent = `Episódio ${ep.episode_number}: ${ep.name || 'Sem título'}`;
            if (ep.episode_number === selectedEpisode) opt.selected = true;
            playerEpisodeSelect.appendChild(opt);
        });
    } else {
        // Fallback option in case of API failure
        for (let i = 1; i <= 10; i++) {
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = `Episódio ${i}`;
            if (i === selectedEpisode) opt.selected = true;
            playerEpisodeSelect.appendChild(opt);
        }
    }
}

// Load episodes for details modal season/episode selectors
async function loadModalEpisodeList(tmdbId, seasonNumber, selectedEpisode) {
    if (!modalEpisodeSelect) return;
    
    modalEpisodeSelect.innerHTML = '';
    const seasonData = await fetchFromTMDB(`/tv/${tmdbId}/season/${seasonNumber}`);
    
    if (seasonData && seasonData.episodes && seasonData.episodes.length > 0) {
        seasonData.episodes.forEach(ep => {
            const opt = document.createElement('option');
            opt.value = ep.episode_number;
            opt.textContent = `Episódio ${ep.episode_number}: ${ep.name || 'Sem título'}`;
            if (ep.episode_number === selectedEpisode) opt.selected = true;
            modalEpisodeSelect.appendChild(opt);
        });
    } else {
        // Fallback option in case of API failure
        for (let i = 1; i <= 10; i++) {
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = `Episódio ${i}`;
            if (i === selectedEpisode) opt.selected = true;
            modalEpisodeSelect.appendChild(opt);
        }
    }
}

function initPlayerEvents() {
    // 1. Loader triggers when iframe loads completely
    playerIframe.addEventListener('load', () => {
        // loadPlayerStream() always resets playerIframe.src = '' at the start of
        // EVERY stream load — including the native_premium path (ClickHost/MegaEmbed/
        // EmbedMovies), which never points the iframe at a real embed URL at all.
        // That reset alone fires this 'load' event for the blank navigation, which
        // would otherwise prematurely reveal the iframe-only overlay controls
        // (fullscreen/prev/next episode — meant for the iframe providers only) and
        // hide the loader while the native resolver is still working in the
        // background. Only treat this as "the embed actually loaded" when there's
        // a real src set.
        const rawSrc = playerIframe.getAttribute('src');
        if (!rawSrc || rawSrc === 'about:blank') return;

        // Simple delay to ensure frame is loaded before removing indicator overlay
        setTimeout(() => {
            playerLoader.classList.add('hidden');
        }, 1200);
        
        // Mark iframe as ready and start intro countdown if data is available
        introIframeReady = true;
        if (currentIntroData) {
            scheduleIntroButton();
        }
        
        // Initially show controls when a new video is loaded
        showPlayerControls();
    });
    
    // 2. Server & Audio selection change triggers player reload
    playerServerSelect.addEventListener('change', () => {
        loadPlayerStream();
    });
    const playerAudioSelect = document.getElementById('player-audio-select');
    if (playerAudioSelect) {
        playerAudioSelect.addEventListener('change', () => {
            loadPlayerStream();
        });
    }
    
    // 3. Exit video playback handler
    closePlayerBtn.addEventListener('click', () => {
        clearIntroTimers(); // Cancel any pending intro timers
        currentIntroData = null;
        playerIframe.removeAttribute('src'); // Tear down video frame instantly to stop audio
        
        // Release the landscape lock (if any) from toggleFullscreen() so the phone doesn't
        // stay stuck in forced landscape after leaving the player.
        if (screen.orientation && screen.orientation.unlock) {
            try { screen.orientation.unlock(); } catch (e) { /* no-op */ }
        }
        
        // Stop and clean native player HLS instance
        if (hlsInstance) {
            hlsInstance.destroy();
            hlsInstance = null;
        }
        if (playerNative) {
            playerNative.pause();
            playerNative.removeAttribute('src');
            playerNative.load();
        }
        
        playerModal.classList.add('hidden');
        document.body.classList.remove('overflow-hidden', 'in-player-mode');
        restoreFloatingAds();
        isPlayerWatching = false;
        stopWatchingApi();
        
        // Ensure main application view (#app) is fully visible and rendered
        const appContainer = document.getElementById('app');
        if (appContainer) {
            appContainer.classList.remove('hidden');
            appContainer.style.removeProperty('display');
            appContainer.style.removeProperty('visibility');
            appContainer.style.removeProperty('opacity');
            appContainer.style.removeProperty('pointer-events');
        }

        if (window.location.hash === '#/' || window.location.hash === '') {
            if (typeof renderApp === 'function') renderApp();
        } else {
            window.location.hash = '#/';
        }
    });
    
    // 4. TV Show navigation click listeners
    if (playerPrevEpBtn) playerPrevEpBtn.addEventListener('click', playPrevEpisode);
    if (playerNextEpBtn) playerNextEpBtn.addEventListener('click', playNextEpisode);
    if (playerSkipIntroBtn) playerSkipIntroBtn.addEventListener('click', skipIntro);

    // 5. Smart overlay triggers (Mouse Move, Mouse Enter/Leave, and click detection)
    if (playerVideoArea) {
        playerVideoArea.addEventListener('mouseenter', () => {
            showPlayerControls();
        });
        playerVideoArea.addEventListener('mousemove', () => {
            showPlayerControls();
        });
    }

    if (playerMouseLayer) {
        playerMouseLayer.addEventListener('mousemove', () => {
            showPlayerControls();
        });
        playerMouseLayer.addEventListener('click', () => {
            showPlayerControls();
        });
    }

    // Direct mousemove/click on native video element (it sits above playerMouseLayer)
    if (playerNative) {
        playerNative.addEventListener('mousemove', () => {
            showPlayerControls();
        });
        playerNative.addEventListener('click', () => {
            // Toggle play/pause on native video click
            if (playerNative.paused) {
                playerNative.play();
            } else {
                playerNative.pause();
            }
            showPlayerControls();
        });
        playerNative.addEventListener('error', () => {
            // Ignore error if failover is currently testing next servers
            if (isNativeFailoverActive) {
                debugLog('[Player] Silencing native video load error (failover is active).');
                return;
            }
            // Check if the error belongs to the currently active stream source
            if (playerNative.src && currentPlayingUrl && playerNative.src !== currentPlayingUrl) {
                debugLog('[Player] Ignoring stale stream load error.');
                return;
            }
            console.error('[Player] Native video load error:', playerNative.error);
            showToast("Erro: O arquivo de vídeo deste episódio não pôde ser carregado (Erro 502/404 do Servidor).");
        });

        // iOS Safari's native video fullscreen (webkitEnterFullscreen) exits without firing
        // the standard fullscreenchange event handleFullscreenChange() listens for below —
        // sync the icon and release the orientation lock manually here.
        playerNative.addEventListener('webkitendfullscreen', () => {
            handleFullscreenChange();
            if (screen.orientation && screen.orientation.unlock) {
                try { screen.orientation.unlock(); } catch (e) { /* no-op */ }
            }
        });
    }

    // Border trigger zones (for cross-domain iframe and fullscreen detection)
    document.querySelectorAll('.player-trigger-zone').forEach(zone => {
        zone.addEventListener('mouseenter', () => {
            showPlayerControls();
        });
        zone.addEventListener('mousemove', () => {
            showPlayerControls();
        });
    });

    if (playerModal) {
        playerModal.addEventListener('mousemove', () => {
            showPlayerControls();
        });
    }

    // Keep controls visible when hovering over the buttons
    [playerModalHeader, playerPrevEpBtn, playerNextEpBtn, playerSkipIntroBtn, playerCustomFullscreenBtn, playerFullscreenShield, nativePlayBtn, nativeRewindBtn, nativeForwardBtn, nativeVolumeBtn, nativeVolumeSlider, nativeFullscreenBtn, nativeZoomBtn, nativeSkipIntroBtn, nativeQualityBtn, nativeAudioBtn, nativePrevEpBtn, nativeNextEpBtn, nativeTimelineContainer].forEach(btn => {
        if (btn) {
            btn.addEventListener('mouseenter', () => {
                isMouseOverControls = true;
                if (playerControlsTimer) {
                    clearTimeout(playerControlsTimer);
                    playerControlsTimer = null;
                }
            });
            btn.addEventListener('mouseleave', () => {
                isMouseOverControls = false;
                playerControlsTimer = setTimeout(hidePlayerControls, 2000);
            });
        }
    });

    // Custom Fullscreen Click Listener
    if (playerCustomFullscreenBtn) {
        playerCustomFullscreenBtn.addEventListener('click', toggleFullscreen);
    }

    // Shield click listener: intercepts click in bottom-right corner and triggers our fullscreen
    if (playerFullscreenShield) {
        playerFullscreenShield.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleFullscreen();
        });
    }

    // Monitor global fullscreen state changes to keep icons in sync
    ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'].forEach(evt => {
        document.addEventListener(evt, handleFullscreenChange);
    });

    // Global keyboard controls for player (Space: Pause/Play, F: Fullscreen, Left/Right: Seek)
    document.addEventListener('keydown', (e) => {
        if (!playerModal || playerModal.classList.contains('hidden')) return;

        // Skip keyboard shortcuts if user is typing in an input, textarea or select
        const activeTag = document.activeElement ? document.activeElement.tagName : '';
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(activeTag) || (document.activeElement && document.activeElement.isContentEditable)) {
            return;
        }

        if (e.code === 'Space' || e.key === ' ') {
            e.preventDefault();
            if (document.activeElement && (document.activeElement.tagName === 'BUTTON' || document.activeElement.tagName === 'A' || document.activeElement.tagName === 'INPUT')) {
                document.activeElement.blur();
            }
            if (playerNative && !playerNative.classList.contains('hidden')) {
                if (playerNative.paused) {
                    playerNative.play().catch(() => {});
                } else {
                    playerNative.pause();
                }
            } else if (playerIframe && !playerIframe.classList.contains('hidden')) {
                try {
                    playerIframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'togglePlay' }), '*');
                    playerIframe.contentWindow.postMessage('togglePlay', '*');
                } catch(err) {}
            }
            showPlayerControls();
        } else if (e.code === 'KeyF' || e.key === 'f' || e.key === 'F') {
            e.preventDefault();
            toggleFullscreen();
        } else if (e.code === 'ArrowLeft') {
            if (playerNative && !playerNative.classList.contains('hidden')) {
                e.preventDefault();
                playerNative.currentTime = Math.max(0, playerNative.currentTime - 10);
                showPlayerControls();
            }
        } else if (e.code === 'ArrowRight') {
            if (playerNative && !playerNative.classList.contains('hidden')) {
                e.preventDefault();
                playerNative.currentTime = Math.min(playerNative.duration || Infinity, playerNative.currentTime + 10);
                showPlayerControls();
            }
        }
    });

    // Detect iframe click via window blur
    window.addEventListener('blur', () => {
        setTimeout(() => {
            if (document.activeElement === playerIframe) {
                showPlayerControls();
            }
        }, 150);
    });

    // Listen for events from players inside iframes (e.g. ended event to auto-play next episode)
    window.addEventListener('message', (event) => {
        try {
            const data = event.data;
            if (!data) return;
            
            debugLog("[Player Message] Received from iframe:", data);
            
            let isEnded = false;
            
            // 1. String message format (simple triggers)
            if (typeof data === 'string') {
                const lower = data.toLowerCase();
                if (lower.includes('ended') || lower === 'finish' || lower === 'complete') {
                    isEnded = true;
                }
            } 
            // 2. Object message format (common player formats like Plyr, Vidstack, JW Player, Vimeo)
            else if (typeof data === 'object') {
                if (data.event === 'ended' || data.event === 'complete' || data.type === 'ended' || data.method === 'ended') {
                    isEnded = true;
                }
                if (data.name === 'ended' || data.id === 'ended') {
                    isEnded = true;
                }
            }
            
            if (isEnded) {
                debugLog("[Player Message] Video ended event detected! Auto-playing next episode...");
                if (currentOpenItem && currentOpenItem.type === 'tv') {
                    showToast("🎥 Próximo episódio carregando automaticamente...");
                    setTimeout(() => {
                        playNextEpisode();
                    }, 1500);
                }
            }
        } catch (e) {
            // Ignore format errors
        }
    });

    // Listen for events on the native player element (ClickHost Native)
    if (playerNative) {
        playerNative.addEventListener('ended', () => {
            debugLog("[Player Native] Video ended natively! Auto-playing next episode...");
            if (currentOpenItem && currentOpenItem.type === 'tv') {
                showToast("🎥 Próximo episódio carregando automaticamente...");
                setTimeout(() => {
                    playNextEpisode();
                }, 1500);
            }
        });
        
        // 1. timeupdate: atualiza a barra de progresso e o relógio de tempo atual
        playerNative.addEventListener('timeupdate', () => {
            if (!playerNative.duration) return;
            
            const current = playerNative.currentTime;
            const duration = playerNative.duration;
            
            // Formata o tempo decorrido (MM:SS ou HH:MM:SS)
            if (nativeTimeCurrent) {
                const hrs = Math.floor(current / 3600);
                const mins = Math.floor((current % 3600) / 60);
                const secs = Math.floor(current % 60);
                
                if (hrs > 0) {
                    nativeTimeCurrent.textContent = `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
                } else {
                    nativeTimeCurrent.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
                }
            }
            
            // Atualiza a largura da barra vermelha de progresso
            if (nativeTimelineProgress) {
                const pct = (current / duration) * 100;
                nativeTimelineProgress.style.width = `${pct}%`;
            }
            
            // Monitora os timestamps da abertura (Skip Intro)
            if (currentIntroData) {
                const timeMs = current * 1000;
                if (timeMs >= currentIntroData.start_ms && timeMs <= currentIntroData.end_ms) {
                    if (nativeSkipIntroBtn && nativeSkipIntroBtn.style.display === 'none') {
                        nativeSkipIntroBtn.style.display = 'flex';
                    }
                } else {
                    if (nativeSkipIntroBtn && nativeSkipIntroBtn.style.display !== 'none') {
                        nativeSkipIntroBtn.style.display = 'none';
                    }
                }
            }
        });
        
        // 2. loadedmetadata: carrega o tempo total do vídeo
        playerNative.addEventListener('loadedmetadata', () => {
            if (!playerNative.duration) return;
            const duration = playerNative.duration;
            
            if (nativeTimeTotal) {
                const hrs = Math.floor(duration / 3600);
                const mins = Math.floor((duration % 3600) / 60);
                const secs = Math.floor(duration % 60);
                
                if (hrs > 0) {
                    nativeTimeTotal.textContent = `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
                } else {
                    nativeTimeTotal.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
                }
            }
        });
        
        // 3. progress: atualiza a barra cinza de buffer (carregamento em background)
        playerNative.addEventListener('progress', () => {
            if (playerNative.buffered.length > 0 && playerNative.duration) {
                const bufferedEnd = playerNative.buffered.end(playerNative.buffered.length - 1);
                const duration = playerNative.duration;
                if (nativeTimelineBuffered) {
                    const pct = (bufferedEnd / duration) * 100;
                    nativeTimelineBuffered.style.width = `${pct}%`;
                }
            }
        });
        
        // 4. play/pause status sync: atualiza os ícones do play
        playerNative.addEventListener('play', () => {
            if (nativePlayBtn) nativePlayBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
            if (nativeCenterPlayBtn) {
                // Icon shown here reflects the action a tap WOULD perform (i.e. pause,
                // since we're now playing) — not that it matters much since this state
                // fades to invisible, but keeps it correct if the fade is interrupted.
                nativeCenterPlayBtn.innerHTML = '<i class="fa-solid fa-pause text-3xl"></i>';
                // Animação central de fade out
                nativeCenterPlayBtn.classList.remove('opacity-100', 'scale-100');
                nativeCenterPlayBtn.classList.add('opacity-0', 'scale-75');
            }
        });
        
        playerNative.addEventListener('pause', () => {
            if (nativePlayBtn) nativePlayBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
            if (nativeCenterPlayBtn) {
                // Bug fix: this used to show a PAUSE icon while the video was paused,
                // which is backwards — the center indicator should show the action a
                // tap will perform (tapping while paused resumes playback), so a PLAY
                // icon is what belongs here.
                nativeCenterPlayBtn.innerHTML = '<i class="fa-solid fa-play text-3xl ml-1"></i>';
                // Animação central de fade in
                nativeCenterPlayBtn.classList.remove('opacity-0', 'scale-75');
                nativeCenterPlayBtn.classList.add('opacity-100', 'scale-100');
            }
        });
        
        // 5. buffering indicator: mostra o loader quando o vídeo trava para carregar
        playerNative.addEventListener('waiting', () => {
            playerLoader.classList.remove('hidden');
        });
        
        playerNative.addEventListener('playing', () => {
            playerLoader.classList.add('hidden');
        });
    }

    // 6. Cliques e Ações nos Botões de Controle Nativo
    if (nativePlayBtn) {
        nativePlayBtn.addEventListener('click', () => {
            if (playerNative) {
                if (playerNative.paused) playerNative.play();
                else playerNative.pause();
                showPlayerControls();
            }
        });
    }
    
    if (nativeClickShield) {
        // Single tap toggles play/pause; a second tap on the SAME side within
        // DOUBLE_TAP_SEEK_WINDOW_MS is instead treated as a ±10s seek gesture
        // (the standard convention in YouTube/Netflix's mobile players). The
        // single-tap action is delayed just long enough to know whether a
        // second tap is coming, so it can be cancelled if it turns out to be
        // the first half of a double-tap.
        nativeClickShield.addEventListener('click', (e) => {
            const rect = nativeClickShield.getBoundingClientRect();
            const side = (e.clientX - rect.left) < rect.width / 2 ? 'left' : 'right';
            const now = Date.now();
            const isDoubleTap = clickShieldLastTapSide === side && (now - clickShieldLastTapTime) < DOUBLE_TAP_SEEK_WINDOW_MS;

            if (isDoubleTap) {
                if (clickShieldTapTimer) {
                    clearTimeout(clickShieldTapTimer);
                    clickShieldTapTimer = null;
                }
                clickShieldLastTapTime = 0; // avoid chaining into a triple-tap
                if (playerNative) {
                    if (side === 'left') {
                        playerNative.currentTime = Math.max(0, playerNative.currentTime - 10);
                        flashSeekIndicator(nativeSeekFlashLeft);
                    } else {
                        playerNative.currentTime = Math.min(playerNative.duration || Infinity, playerNative.currentTime + 10);
                        flashSeekIndicator(nativeSeekFlashRight);
                    }
                    showPlayerControls();
                }
                return;
            }

            clickShieldLastTapTime = now;
            clickShieldLastTapSide = side;
            clickShieldTapTimer = setTimeout(() => {
                if (playerNative) {
                    if (playerNative.paused) playerNative.play();
                    else playerNative.pause();
                    showPlayerControls();
                }
                clickShieldTapTimer = null;
            }, DOUBLE_TAP_SEEK_WINDOW_MS);
        });
    }
    
    if (nativeRewindBtn) {
        nativeRewindBtn.addEventListener('click', () => {
            if (playerNative) {
                playerNative.currentTime = Math.max(0, playerNative.currentTime - 10);
                showPlayerControls();
            }
        });
    }
    
    if (nativeForwardBtn) {
        nativeForwardBtn.addEventListener('click', () => {
            if (playerNative) {
                playerNative.currentTime = Math.min(playerNative.duration || 0, playerNative.currentTime + 10);
                showPlayerControls();
            }
        });
    }
    
    if (nativeVolumeBtn) {
        nativeVolumeBtn.addEventListener('click', () => {
            if (playerNative) {
                playerNative.muted = !playerNative.muted;
                if (nativeVolumeSlider) nativeVolumeSlider.value = playerNative.muted ? 0 : playerNative.volume;
                nativeVolumeBtn.innerHTML = playerNative.muted 
                    ? '<i class="fa-solid fa-volume-xmark"></i>' 
                    : (playerNative.volume > 0.5 ? '<i class="fa-solid fa-volume-high"></i>' : '<i class="fa-solid fa-volume-low"></i>');
            }
        });
    }
    
    if (nativeVolumeSlider) {
        nativeVolumeSlider.addEventListener('input', (e) => {
            if (playerNative) {
                const vol = parseFloat(e.target.value);
                playerNative.volume = vol;
                playerNative.muted = vol === 0;
                nativeVolumeBtn.innerHTML = playerNative.muted 
                    ? '<i class="fa-solid fa-volume-xmark"></i>' 
                    : (vol > 0.5 ? '<i class="fa-solid fa-volume-high"></i>' : '<i class="fa-solid fa-volume-low"></i>');
            }
        });
    }
    
    if (nativeFullscreenBtn) {
        nativeFullscreenBtn.addEventListener('click', () => {
            toggleFullscreen();
        });
    }

    if (nativeZoomBtn) {
        nativeZoomBtn.addEventListener('click', () => {
            if (!playerNative) return;
            isZoomFillActive = !isZoomFillActive;
            playerNative.classList.toggle('object-cover', isZoomFillActive);
            playerNative.classList.toggle('object-contain', !isZoomFillActive);
            const zoomIcon = nativeZoomBtn.querySelector('i');
            if (zoomIcon) {
                zoomIcon.classList.toggle('fa-down-left-and-up-right-to-center', isZoomFillActive);
                zoomIcon.classList.toggle('fa-up-right-and-down-left-from-center', !isZoomFillActive);
            }
            nativeZoomBtn.title = isZoomFillActive ? 'Tela Original' : 'Preencher Tela';
            showPlayerControls();
        });
    }
    
    // Quality & Audio selectors: toggle menu open/closed, and close when clicking outside
    if (nativeQualityBtn) {
        nativeQualityBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (nativeAudioMenu) nativeAudioMenu.classList.add('hidden');
            if (nativeSubtitleMenu) nativeSubtitleMenu.classList.add('hidden');
            if (nativeQualityMenu) nativeQualityMenu.classList.toggle('hidden');
            showPlayerControls();
        });
    }
    if (nativeAudioBtn) {
        nativeAudioBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (nativeQualityMenu) nativeQualityMenu.classList.add('hidden');
            if (nativeSubtitleMenu) nativeSubtitleMenu.classList.add('hidden');
            if (nativeAudioMenu) nativeAudioMenu.classList.toggle('hidden');
            showPlayerControls();
        });
    }
    if (nativeSubtitleBtn) {
        nativeSubtitleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (nativeQualityMenu) nativeQualityMenu.classList.add('hidden');
            if (nativeAudioMenu) nativeAudioMenu.classList.add('hidden');
            if (nativeSubtitleMenu) nativeSubtitleMenu.classList.toggle('hidden');
            showPlayerControls();
        });
    }
    if (nativeQualityMenu) {
        nativeQualityMenu.addEventListener('click', (e) => e.stopPropagation());
    }
    if (nativeAudioMenu) {
        nativeAudioMenu.addEventListener('click', (e) => e.stopPropagation());
    }
    if (nativeSubtitleMenu) {
        nativeSubtitleMenu.addEventListener('click', (e) => e.stopPropagation());
    }
    document.addEventListener('click', () => {
        if (nativeQualityMenu) nativeQualityMenu.classList.add('hidden');
        if (nativeAudioMenu) nativeAudioMenu.classList.add('hidden');
        if (nativeSubtitleMenu) nativeSubtitleMenu.classList.add('hidden');
    });
    
    if (nativePrevEpBtn) {
        nativePrevEpBtn.addEventListener('click', () => {
            if (playerPrevEpBtn) playerPrevEpBtn.click();
        });
    }
    
    if (nativeNextEpBtn) {
        nativeNextEpBtn.addEventListener('click', () => {
            if (playerNextEpBtn) playerNextEpBtn.click();
        });
    }
    
    if (nativeSkipIntroBtn) {
        nativeSkipIntroBtn.addEventListener('click', () => {
            if (playerNative && currentIntroData && currentIntroData.end_ms) {
                playerNative.currentTime = currentIntroData.end_ms / 1000;
                nativeSkipIntroBtn.style.display = 'none';
                showToast("⏭️ Abertura pulada!");
            }
        });
    }
    
    if (nativeTimelineContainer) {
        // Drag-to-seek in addition to tap/click — precisely tapping a ~6px-tall bar is hard
        // on a phone screen, dragging the thumb across it is the gesture users actually expect.
        let isScrubbingTimeline = false;
        const seekTimelineToClientX = (clientX) => {
            if (!playerNative || !playerNative.duration) return;
            const rect = nativeTimelineContainer.getBoundingClientRect();
            const pos = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
            playerNative.currentTime = pos * playerNative.duration;
            // Instant visual feedback while dragging, instead of waiting for the next 'timeupdate' tick
            if (nativeTimelineProgress) nativeTimelineProgress.style.width = `${pos * 100}%`;
        };
        nativeTimelineContainer.addEventListener('click', (e) => {
            seekTimelineToClientX(e.clientX);
        });
        nativeTimelineContainer.addEventListener('touchstart', (e) => {
            isScrubbingTimeline = true;
            showPlayerControls();
            seekTimelineToClientX(e.touches[0].clientX);
        }, { passive: true });
        nativeTimelineContainer.addEventListener('touchmove', (e) => {
            if (!isScrubbingTimeline) return;
            seekTimelineToClientX(e.touches[0].clientX);
        }, { passive: true });
    }
    
    // Subtitle Keyboard Sync Shortcuts: G = Atrasar 0.5s | H = Adiantar 0.5s | J = Resetar 0s
    document.addEventListener('keydown', (e) => {
        if (!isPlayerWatching || !playerModal || playerModal.classList.contains('hidden')) return;
        const activeEl = document.activeElement;
        if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT')) return;

        if (e.code === 'KeyG' || e.key === 'g' || e.key === 'G') {
            e.preventDefault();
            adjustSubtitleSync(-0.5);
        } else if (e.code === 'KeyH' || e.key === 'h' || e.key === 'H') {
            e.preventDefault();
            adjustSubtitleSync(0.5);
        } else if (e.code === 'KeyJ' || e.key === 'j' || e.key === 'J') {
            e.preventDefault();
            resetSubtitleSync();
        }
    });
}

/**
 * CLIENT-SIDE ROUTER & AUTH SYSTEMS (SPA CHANNELS)
 */

let cachedFilmes = [];
let cachedSeries = [];
let cachedAnimes = [];
let exploreCatalogsLoaded = false;

async function fetchFilmesCatalog() {
    let allMovies = [];
    for (let page = 1; page <= 5; page++) {
        const data = await fetchFromTMDB('/discover/movie', {
            'sort_by': 'popularity.desc',
            'page': page.toString(),
            'vote_count.gte': MIN_DISCOVER_VOTE_COUNT,
            'without_keywords': BLOCKED_ADULT_KEYWORD_IDS
        });
        if (data && data.results) {
            allMovies = [...allMovies, ...data.results.filter(m => !isExplicitContent(m))];
        }
    }
    const uniqueMap = {};
    allMovies.forEach(m => uniqueMap[m.id] = m);
    cachedFilmes = Object.values(uniqueMap);
}

async function fetchSeriesCatalog() {
    let allSeries = [];
    for (let page = 1; page <= 5; page++) {
        const data = await fetchFromTMDB('/discover/tv', {
            'sort_by': 'popularity.desc',
            'page': page.toString(),
            'vote_count.gte': MIN_DISCOVER_VOTE_COUNT,
            'without_keywords': BLOCKED_ADULT_KEYWORD_IDS
        });
        if (data && data.results) {
            allSeries = [...allSeries, ...data.results.filter(s => !isExplicitContent(s))];
        }
    }
    const uniqueMap = {};
    allSeries.forEach(s => uniqueMap[s.id] = s);
    cachedSeries = Object.values(uniqueMap);
}

async function fetchAnimesCatalog() {
    let allAnimes = [];
    for (let page = 1; page <= 5; page++) {
        const data = await fetchFromTMDB('/discover/tv', {
            'with_genres': '16',
            'with_original_language': 'ja',
            'sort_by': 'popularity.desc',
            'page': page.toString(),
            'vote_count.gte': MIN_DISCOVER_VOTE_COUNT,
            'without_keywords': BLOCKED_ADULT_KEYWORD_IDS
        });
        if (data && data.results) {
            allAnimes = [...allAnimes, ...data.results.filter(a => !isExplicitContent(a))];
        }
    }
    const uniqueMap = {};
    allAnimes.forEach(a => uniqueMap[a.id] = a);
    cachedAnimes = Object.values(uniqueMap);
}

// Curated genre buckets for the Explorar discovery grid, mapped to TMDB's
// movie/tv genre ids (they use separate id namespaces per media type). Some
// buckets are media-type specific (e.g. "Romance" has no TV equivalent) — in
// that case the missing side is an empty array, which simply yields zero
// matches for that media type + genre combination.
const EXPLORE_GENRES = [
    { name: 'Ação & Aventura', movie: [28, 12], tv: [10759] },
    { name: 'Animação', movie: [16], tv: [16] },
    { name: 'Comédia', movie: [35], tv: [35] },
    { name: 'Crime', movie: [80], tv: [80] },
    { name: 'Documentário', movie: [99], tv: [99] },
    { name: 'Drama', movie: [18], tv: [18] },
    { name: 'Família', movie: [10751], tv: [10751] },
    { name: 'Fantasia & Sci-Fi', movie: [14, 878], tv: [10765] },
    { name: 'Guerra', movie: [10752], tv: [10768] },
    { name: 'Mistério', movie: [9648], tv: [9648] },
    { name: 'Romance', movie: [10749], tv: [] },
    { name: 'Terror', movie: [27], tv: [] },
    { name: 'Thriller', movie: [53], tv: [] },
    { name: 'Faroeste', movie: [37], tv: [37] },
];

// Merges the three prefetched catalogs into a single tagged list for the
// Explorar discovery grid. Series that are actually Japanese anime (already
// present in cachedAnimes) are excluded from the "tv" bucket to avoid
// showing the same title twice under both Séries and Animes.
function getExploreCombinedCatalog() {
    const animeIds = new Set(cachedAnimes.map(a => a.id));
    const movies = cachedFilmes.map(m => ({ ...m, _kind: 'movie' }));
    const series = cachedSeries.filter(s => !animeIds.has(s.id)).map(s => ({ ...s, _kind: 'tv' }));
    const animes = cachedAnimes.map(a => ({ ...a, _kind: 'anime' }));
    return [...movies, ...series, ...animes];
}

let exploreQueryState = null; // Pagination state for live TMDB discover queries on Explorar (null when browsing the local combined catalog or a search query)

// Converts the Explorar "Ano" filter (an exact year, e.g. '2014') into TMDB
// discover date-range params for the given date field (primary_release_date
// for movies, first_air_date for tv), spanning the full Jan 1 - Dec 31 range.
function exploreYearRangeParams(field, yearVal) {
    if (yearVal === 'all' || !yearVal) return {};
    return { [`${field}.gte`]: `${yearVal}-01-01`, [`${field}.lte`]: `${yearVal}-12-31` };
}

// Live-queries TMDB's /discover endpoint for a single Explorar "Tipo" (movie, tv or
// anime), applying the selected genre/year filters server-side so results aren't
// capped by the small locally cached catalog. Supports pagination for "Carregar mais".
async function fetchExplorePage(typeVal, genreVal, yearVal, page) {
    if (typeVal === 'all') {
        const [movieRes, tvRes] = await Promise.all([
            fetchExplorePage('movie', genreVal, yearVal, page),
            fetchExplorePage('tv', genreVal, yearVal, page)
        ]);
        const uniqueMap = {};
        [...movieRes.items, ...tvRes.items].forEach(it => {
            const key = `${it._kind}-${it.id}`;
            if (!uniqueMap[key]) uniqueMap[key] = it;
        });
        const items = Object.values(uniqueMap);
        const totalPages = Math.max(movieRes.totalPages || 0, tvRes.totalPages || 0);
        return { items, totalPages };
    }

    const bucket = genreVal !== 'all' ? EXPLORE_GENRES.find(g => g.name === genreVal) : null;
    const params = { 'sort_by': 'popularity.desc', 'page': page.toString(), 'vote_count.gte': MIN_DISCOVER_VOTE_COUNT, 'without_keywords': BLOCKED_ADULT_KEYWORD_IDS };
    let endpoint, kind;

    if (typeVal === 'anime') {
        endpoint = '/discover/tv';
        kind = 'anime';
        params.with_original_language = 'ja';
        const ids = new Set(['16', ...(bucket ? bucket.tv.map(String) : [])]);
        params.with_genres = [...ids].join(',');
        Object.assign(params, exploreYearRangeParams('first_air_date', yearVal));
    } else if (typeVal === 'tv') {
        endpoint = '/discover/tv';
        kind = 'tv';
        if (bucket) {
            if (bucket.tv.length === 0) return { items: [], totalPages: 0 };
            params.with_genres = bucket.tv.join(',');
        }
        Object.assign(params, exploreYearRangeParams('first_air_date', yearVal));
    } else {
        endpoint = '/discover/movie';
        kind = 'movie';
        if (bucket) {
            if (bucket.movie.length === 0) return { items: [], totalPages: 0 };
            params.with_genres = bucket.movie.join(',');
        }
        Object.assign(params, exploreYearRangeParams('primary_release_date', yearVal));
    }

    const data = await fetchFromTMDB(endpoint, params);
    if (!data || !data.results) return { items: [], totalPages: 0 };

    let items = data.results.filter(it => !isExplicitContent(it));
    if (kind === 'tv') {
        // Exclude titles already classified as anime to avoid duplicates with the Anime bucket.
        const animeIds = new Set(cachedAnimes.map(a => a.id));
        items = items.filter(it => !animeIds.has(it.id));
    }
    items = items.map(it => ({ ...it, _kind: kind }));
    return { items, totalPages: Math.min(data.total_pages || 1, 500) };
}

function sortExploreResults(results, sortVal) {
    return [...results].sort((a, b) => {
        if (sortVal === 'vote_average') return (b.vote_average || 0) - (a.vote_average || 0);
        if (sortVal === 'release_date') {
            return new Date(b.release_date || b.first_air_date || 0) - new Date(a.release_date || a.first_air_date || 0);
        }
        if (sortVal === 'title') {
            return (a.title || a.name || '').localeCompare(b.title || b.name || '');
        }
        return (b.popularity || 0) - (a.popularity || 0);
    });
}

function updateExploreLoadMoreButton() {
    const btn = document.getElementById('explore-load-more-btn');
    if (!btn) return;
    const canLoadMore = exploreQueryState && exploreQueryState.page < exploreQueryState.totalPages;
    btn.classList.toggle('hidden', !canLoadMore);
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-chevron-down mr-2"></i>Carregar mais';
}

// Fetches the next page of the current live Explorar discover query and appends
// the results to the grid, instead of replacing it (used by the "Carregar mais" button).
async function loadMoreExploreResults() {
    if (!exploreQueryState || exploreQueryState.page >= exploreQueryState.totalPages) return;

    const loadMoreBtn = document.getElementById('explore-load-more-btn');
    const grid = document.getElementById('explore-grid');
    const counter = document.getElementById('explore-counter');
    if (loadMoreBtn) {
        loadMoreBtn.disabled = true;
        loadMoreBtn.innerHTML = '<i class="fa-solid fa-spinner animate-spin mr-2"></i>Carregando...';
    }

    const nextPage = exploreQueryState.page + 1;
    const { items } = await fetchExplorePage(exploreQueryState.typeVal, exploreQueryState.genreVal, exploreQueryState.yearVal, nextPage);
    const sorted = sortExploreResults(items, exploreQueryState.sortVal);

    exploreQueryState.page = nextPage;
    exploreQueryState.loadedCount += sorted.length;

    sorted.forEach(item => {
        if (grid) grid.appendChild(createPosterCard(item, item._kind === 'movie' ? 'movie' : 'tv', 'lg'));
    });
    if (counter) {
        counter.textContent = `${exploreQueryState.loadedCount} título${exploreQueryState.loadedCount !== 1 ? 's' : ''} encontrado${exploreQueryState.loadedCount !== 1 ? 's' : ''}`;
    }

    updateExploreLoadMoreButton();
}

function handlePathRoute() {
    const path = window.location.pathname;
    const filmeMatch = path.match(/^\/filme\/(\d+)/);
    const serieMatch = path.match(/^\/serie\/(\d+)/);
    if (filmeMatch) {
        const id = parseInt(filmeMatch[1]);
        openDetailsModal(id, 'movie');
    } else if (serieMatch) {
        const id = parseInt(serieMatch[1]);
        openDetailsModal(id, 'tv');
    } else {
        if (typeof detailsModal !== 'undefined' && !detailsModal.classList.contains('hidden')) {
            closeDetails();
        }
    }
}

function initRouter() {
    window.addEventListener('hashchange', handleRoute);
    window.addEventListener('popstate', handlePathRoute);
    handleRoute();
    handlePathRoute();
}

function handleRoute() {
    // Automatically close player if open when routing changes (e.g. browser back button)
    if (playerModal && !playerModal.classList.contains('hidden')) {
        clearIntroTimers();
        currentIntroData = null;
        playerIframe.removeAttribute('src');
        if (hlsInstance) {
            hlsInstance.destroy();
            hlsInstance = null;
        }
        if (playerNative) {
            playerNative.pause();
            playerNative.removeAttribute('src');
            playerNative.load();
        }
        playerModal.classList.add('hidden');
        document.body.classList.remove('overflow-hidden');
        isPlayerWatching = false;
        stopWatchingApi();
    }

    const hash = window.location.hash || '#/';
    const user = JSON.parse(localStorage.getItem('brflix-user'));
    const isAuthRoute = hash === '#/login' || hash === '#/cadastro';
    
    // Auth route guards: Minha Lista, Settings and Subscription pages require login
    const requiresAuth = hash === '#/minha-lista' || hash === '#/configuracoes' || hash === '#/assinatura';
    if (!user && requiresAuth) {
        showToast("Faça login para acessar esta página!");
        window.location.hash = '#/login';
        return;
    }
    
    if (user && isAuthRoute) {
        window.location.hash = '#/';
        return;
    }
    
    // Hide all views
    document.querySelectorAll('[id^="view-"]').forEach(el => el.classList.add('hidden'));
    
    // Show main header and footer for internal pages
    const headerLoginBtn = document.getElementById('header-login-btn');
    const headerUserMenu = document.getElementById('header-user-menu');
    if (isAuthRoute) {
        mainHeader.classList.add('hidden');
        document.querySelector('footer').classList.add('hidden');
    } else {
        mainHeader.classList.remove('hidden');
        document.querySelector('footer').classList.remove('hidden');
        
        // Show/hide profile or login buttons depending on auth state
        if (user) {
            if (headerLoginBtn) headerLoginBtn.classList.add('hidden');
            if (headerUserMenu) headerUserMenu.classList.remove('hidden');
            updateHeaderAvatar();
        } else {
            if (headerLoginBtn) headerLoginBtn.classList.remove('hidden');
            if (headerUserMenu) headerUserMenu.classList.add('hidden');
        }
    }
    
    // Remove active state from nav links
    document.querySelectorAll('header nav a').forEach(el => {
        el.className = 'text-textSec hover:text-white transition-colors duration-200';
    });
    
    // Route matching
    if (hash === '#/login') {
        document.getElementById('view-login').classList.remove('hidden');
    } else if (hash === '#/cadastro') {
        document.getElementById('view-cadastro').classList.remove('hidden');
    } else if (hash === '#/filmes') {
        document.getElementById('view-filmes').classList.remove('hidden');
        const link = document.getElementById('nav-filmes');
        link.className = 'text-white border-b-2 border-brand pb-1 transition-colors duration-200';
        renderFilmesPage();
    } else if (hash === '#/series') {
        document.getElementById('view-series').classList.remove('hidden');
        const link = document.getElementById('nav-series');
        link.className = 'text-white border-b-2 border-brand pb-1 transition-colors duration-200';
        renderSeriesPage();
    } else if (hash === '#/animes') {
        document.getElementById('view-animes').classList.remove('hidden');
        const link = document.getElementById('nav-animes');
        if (link) link.className = 'text-white border-b-2 border-brand pb-1 transition-colors duration-200';
    } else if (hash === '#/canais') {
        const viewCanais = document.getElementById('view-canais');
        if (viewCanais) viewCanais.classList.remove('hidden');
        const link = document.getElementById('nav-canais');
        if (link) link.className = 'text-white border-b-2 border-brand pb-1 transition-colors duration-200';
    } else if (hash === '#/explorar') {
        document.getElementById('view-explorar').classList.remove('hidden');
        const link = document.getElementById('nav-explorar');
        link.className = 'text-white border-b-2 border-brand pb-1 transition-colors duration-200';
        renderExplorarPage();
    } else if (hash === '#/minha-lista') {
        document.getElementById('view-minha-lista').classList.remove('hidden');
        const link = document.getElementById('nav-lista');
        link.className = 'text-white border-b-2 border-brand pb-1 transition-colors duration-200';
        renderMinhaListaPage();
    } else if (hash === '#/configuracoes') {
        document.getElementById('view-configuracoes').classList.remove('hidden');
        renderConfiguracoesPage();
    } else if (hash === '#/assinatura') {
        document.getElementById('view-assinatura').classList.remove('hidden');
        const link = document.getElementById('nav-assinatura');
        if (link) link.className = 'text-white border-b-2 border-brand pb-1 transition-colors duration-200';
        initSubscriptionTab();
    } else if (hash === '#/dmca') {
        document.getElementById('view-dmca').classList.remove('hidden');
    } else if (hash === '#/contato' || hash === '#/central-de-ajuda') {
        document.getElementById('view-contato').classList.remove('hidden');
    } else if (hash === '#/baixar') {
        document.getElementById('view-baixar').classList.remove('hidden');
        const link = document.getElementById('nav-baixar');
        if (link) link.className = 'text-white border-b-2 border-brand pb-1 transition-colors duration-200';
    } else if (hash.startsWith('#/detalhes/')) {
        document.getElementById('view-home').classList.remove('hidden');
        const parts = hash.split('/');
        const type = parts[2] === 'tv' ? 'tv' : 'movie';
        const tmdbId = parseInt(parts[3], 10);
        if (tmdbId) {
            openDetailsModal(tmdbId, type);
        }
    } else {
        // Default to home
        document.getElementById('view-home').classList.remove('hidden');
        const link = document.getElementById('nav-inicio');
        link.className = 'text-white border-b-2 border-brand pb-1 transition-colors duration-200';
        renderPlaylist();
    }

    // Keeps the browser tab title relevant to the current section (SEO + UX).
    const ROUTE_TITLES = {
        '#/contato': 'Contato & Suporte | BRFLIX',
        '#/filmes': 'Filmes Online Grátis | BRFLIX',
        '#/series': 'Séries Online Grátis | BRFLIX',
        '#/animes': 'Animes Online Grátis | BRFLIX',
        '#/explorar': 'Explorar Catálogo | BRFLIX',
        '#/minha-lista': 'Minha Lista | BRFLIX',
        '#/configuracoes': 'Configurações | BRFLIX',
        '#/assinatura': 'Assinatura Premium | BRFLIX',
        '#/dmca': 'DMCA | BRFLIX',
        '#/privacidade': 'Política de Privacidade | BRFLIX',
        '#/baixar': 'Baixar Aplicativo Oficial | BRFLIX',
        '#/login': 'Entrar | BRFLIX',
        '#/cadastro': 'Criar Conta | BRFLIX',
    };
    document.title = ROUTE_TITLES[hash] || 'BRFLIX - Assistir Filmes, Séries e Animes Online Grátis';

    updateBottomNavActive(hash);
    window.scrollTo({ top: 0 });
    setTimeout(injectAdsIntoStaticCarousels, 100);
}

// Keeps the mobile bottom tab bar (Início/Filmes/Séries/Buscar/Mais) in sync
// with the current route. "Mais" lights up for routes that live inside the
// side menu instead of having their own bottom-nav slot.
function updateBottomNavActive(hash) {
    document.querySelectorAll('.bottom-nav-link').forEach(el => el.classList.remove('active'));

    let activeId = null;
    if (hash === '#/filmes') activeId = 'bottomnav-filmes';
    else if (hash === '#/series') activeId = 'bottomnav-series';
    else if (hash === '#/explorar') activeId = 'bottomnav-buscar';
    else if (hash === '#/animes' || hash === '#/minha-lista' || hash === '#/configuracoes' || hash === '#/assinatura') activeId = 'bottomnav-mais';
    else if (!hash || hash === '#/' || hash === '#') activeId = 'bottomnav-inicio';

    if (activeId) {
        const el = document.getElementById(activeId);
        if (el) el.classList.add('active');
    }
}

function renderFilmesPage() {
    const grid = document.getElementById('filmes-grid');
    const counter = document.getElementById('filmes-counter');
    const fGenre = document.getElementById('filter-filmes-genre');
    const fYear = document.getElementById('filter-filmes-year');
    const fSort = document.getElementById('filter-filmes-sort');
    
    if (!grid || !fGenre || !fYear || !fSort) return;
    
    const genreFilter = fGenre.value;
    const yearFilter = fYear.value;
    const sortFilter = fSort.value;
    
    let filtered = [...cachedFilmes];
    
    if (genreFilter !== 'all') {
        const genreId = parseInt(genreFilter);
        filtered = filtered.filter(m => m.genre_ids && m.genre_ids.includes(genreId));
    }
    
    if (yearFilter !== 'all') {
        filtered = filtered.filter(m => {
            const yearStr = (m.release_date || '').split('-')[0];
            if (!yearStr) return false;
            const year = parseInt(yearStr);
            if (yearFilter === '2020s') return year >= 2020;
            if (yearFilter === '2010s') return year >= 2010 && year < 2020;
            if (yearFilter === '2000s') return year >= 2000 && year < 2010;
            if (yearFilter === 'old') return year < 2000;
            return true;
        });
    }
    
    filtered.sort((a, b) => {
        if (sortFilter === 'popularity') return b.popularity - a.popularity;
        if (sortFilter === 'vote_average') return b.vote_average - a.vote_average;
        if (sortFilter === 'release_date') {
            return new Date(b.release_date || 0) - new Date(a.release_date || 0);
        }
        if (sortFilter === 'title') {
            return (a.title || '').localeCompare(b.title || '');
        }
        return 0;
    });
    
    counter.textContent = `${filtered.length} título${filtered.length !== 1 ? 's' : ''} disponível${filtered.length !== 1 ? 's' : ''}`;
    
    grid.innerHTML = '';
    if (filtered.length === 0) {
        grid.innerHTML = `<div class="col-span-full text-center py-12 text-textSec text-sm">Nenhum título corresponde aos filtros aplicados.</div>`;
        return;
    }
    
    filtered.forEach((m, idx) => {
        if (idx > 0 && idx % 6 === 0) {
            grid.appendChild(createSponsoredPosterCard(Math.floor(idx / 6), 'sm'));
        }
        const card = createPosterCard(m, 'movie');
        grid.appendChild(card);
    });
}

function renderSeriesPage() {
    const grid = document.getElementById('series-grid');
    const counter = document.getElementById('series-counter');
    const fGenre = document.getElementById('filter-series-genre');
    const fSort = document.getElementById('filter-series-sort');
    
    if (!grid || !fGenre || !fSort) return;
    
    const genreFilter = fGenre.value;
    const sortFilter = fSort.value;
    
    let filtered = [...cachedSeries];
    
    if (genreFilter !== 'all') {
        const genreId = parseInt(genreFilter);
        filtered = filtered.filter(s => s.genre_ids && s.genre_ids.includes(genreId));
    }
    
    filtered.sort((a, b) => {
        if (sortFilter === 'popularity') return b.popularity - a.popularity;
        if (sortFilter === 'vote_average') return b.vote_average - a.vote_average;
        if (sortFilter === 'first_air_date') {
            return new Date(b.first_air_date || 0) - new Date(a.first_air_date || 0);
        }
        if (sortFilter === 'name') {
            return (a.name || '').localeCompare(b.name || '');
        }
        return 0;
    });
    
    counter.textContent = `${filtered.length} título${filtered.length !== 1 ? 's' : ''} disponível${filtered.length !== 1 ? 's' : ''}`;
    
    grid.innerHTML = '';
    if (filtered.length === 0) {
        grid.innerHTML = `<div class="col-span-full text-center py-12 text-textSec text-sm">Nenhuma série corresponde aos filtros aplicados.</div>`;
        return;
    }
    
    filtered.forEach((s, idx) => {
        if (idx > 0 && idx % 6 === 0) {
            grid.appendChild(createSponsoredPosterCard(Math.floor(idx / 6), 'sm'));
        }
        const card = createPosterCard(s, 'tv');
        grid.appendChild(card);
    });
}

function initExplorePage() {
    const input = document.getElementById('explore-search-input');
    const typeFilter = document.getElementById('explore-filter-type');
    const genreFilter = document.getElementById('explore-filter-genre');
    const yearFilter = document.getElementById('explore-filter-year');
    const sortFilter = document.getElementById('explore-filter-sort');

    if (!input) return;

    // Populate the genre dropdown once with the curated bucket list
    if (genreFilter && genreFilter.options.length <= 1) {
        EXPLORE_GENRES.forEach(g => {
            const opt = document.createElement('option');
            opt.value = g.name;
            opt.textContent = g.name;
            genreFilter.appendChild(opt);
        });
    }

    // Populate the year dropdown once with every individual year, newest first
    if (yearFilter && yearFilter.options.length <= 1) {
        const currentYear = new Date().getFullYear();
        for (let y = currentYear; y >= 1950; y--) {
            const opt = document.createElement('option');
            opt.value = y.toString();
            opt.textContent = y.toString();
            yearFilter.appendChild(opt);
        }
    }

    let exploreDebounce = null;
    input.addEventListener('input', () => {
        clearTimeout(exploreDebounce);
        exploreDebounce = setTimeout(applyExploreFilters, 350);
    });

    [typeFilter, genreFilter, yearFilter, sortFilter].forEach(el => {
        if (el) el.addEventListener('change', applyExploreFilters);
    });

    const loadMoreBtn = document.getElementById('explore-load-more-btn');
    if (loadMoreBtn) loadMoreBtn.addEventListener('click', loadMoreExploreResults);

    // Infinite Scroll: Automatically load next page when user scrolls near the bottom of Explorar view
    window.addEventListener('scroll', () => {
        const viewExplorar = document.getElementById('view-explorar');
        if (!viewExplorar || viewExplorar.classList.contains('hidden')) return;
        if (!exploreQueryState || exploreQueryState.page >= exploreQueryState.totalPages) return;
        
        const scrollPosition = window.innerHeight + window.scrollY;
        const threshold = document.body.offsetHeight - 800;
        if (scrollPosition >= threshold) {
            loadMoreExploreResults();
        }
    }, { passive: true });
}

function renderExplorarPage() {
    const grid = document.getElementById('explore-grid');
    if (!exploreCatalogsLoaded) {
        if (grid) grid.innerHTML = `<div class="col-span-full text-center py-16 text-textSec text-sm"><i class="fa-solid fa-spinner animate-spin mr-2 text-brand"></i>Carregando catálogo...</div>`;
        return;
    }
    applyExploreFilters();
}

// Live multi-search across all of TMDB (not limited to the header dropdown's
// 7-result preview), used by the Explorar grid when the user types a query.
async function performSearchFull(query) {
    const data = await fetchFromTMDB('/search/multi', { query: query, include_adult: 'false' });
    if (data && data.results) {
        return data.results.filter(item => {
            if (item.media_type !== 'movie' && item.media_type !== 'tv') return false;
            if (isExplicitContent(item)) return false;
            return true;
        });
    }
    return [];
}

// Same out-of-order-response guard as searchRequestId above, applied to the
// Explorar grid's live search/filter queries.
let exploreRequestId = 0;

async function applyExploreFilters() {
    const requestId = ++exploreRequestId;
    const isStale = () => requestId !== exploreRequestId;

    const input = document.getElementById('explore-search-input');
    const typeFilter = document.getElementById('explore-filter-type');
    const genreFilter = document.getElementById('explore-filter-genre');
    const yearFilter = document.getElementById('explore-filter-year');
    const sortFilter = document.getElementById('explore-filter-sort');
    const grid = document.getElementById('explore-grid');
    const counter = document.getElementById('explore-counter');
    const emptyState = document.getElementById('explore-empty-state');
    const loadMoreBtn = document.getElementById('explore-load-more-btn');

    if (!grid) return;

    const query = input ? input.value.trim() : '';
    const typeVal = typeFilter ? typeFilter.value : 'all';
    const genreVal = genreFilter ? genreFilter.value : 'all';
    const yearVal = yearFilter ? yearFilter.value : 'all';
    const sortVal = sortFilter ? sortFilter.value : 'popularity';

    exploreQueryState = null;
    if (loadMoreBtn) loadMoreBtn.classList.add('hidden');
    grid.innerHTML = `<div class="col-span-full text-center py-16 text-textSec text-sm"><i class="fa-solid fa-spinner animate-spin mr-2 text-brand"></i>Buscando...</div>`;
    if (emptyState) emptyState.classList.add('hidden');

    const renderFinal = (items) => {
        grid.innerHTML = '';
        if (counter) counter.textContent = `${items.length} título${items.length !== 1 ? 's' : ''} encontrado${items.length !== 1 ? 's' : ''}`;
        if (items.length === 0) {
            if (emptyState) emptyState.classList.remove('hidden');
            return;
        }
        items.forEach((item, idx) => {
            if (idx > 0 && idx % 6 === 0) {
                grid.appendChild(createSponsoredPosterCard(Math.floor(idx / 6), 'lg'));
            }
            const type = item._kind === 'movie' ? 'movie' : 'tv';
            grid.appendChild(createPosterCard(item, type, 'lg'));
        });
    };

    if (query) {
        // Live TMDB search — genre/year filters don't apply server-side here,
        // but the "Tipo" filter still narrows the results client-side. Search
        // results aren't paginated (TMDB's first page is usually enough here).
        const animeIds = new Set(cachedAnimes.map(a => a.id));
        const searchResults = await performSearchFull(query);
        if (isStale()) return; // a newer query/filter change started meanwhile — discard
        let results = searchResults.map(item => ({
            ...item,
            _kind: item.media_type === 'movie' ? 'movie' : (animeIds.has(item.id) ? 'anime' : 'tv')
        }));
        if (typeVal !== 'all') results = results.filter(item => item._kind === typeVal);
        renderFinal(sortExploreResults(results, sortVal));
        return;
    }

    // Query TMDB discover live so genre/year filters aren't limited to a small local cache, with real pagination.
    const { items, totalPages } = await fetchExplorePage(typeVal, genreVal, yearVal, 1);
    if (isStale()) return; // a newer query/filter change started meanwhile — discard
    const sorted = sortExploreResults(items, sortVal);
    exploreQueryState = { typeVal, genreVal, yearVal, sortVal, page: 1, totalPages, loadedCount: sorted.length };
    renderFinal(sorted);
    if (sorted.length > 0) updateExploreLoadMoreButton();
}

function renderMinhaListaPage() {
    const grid = document.getElementById('my-list-grid');
    const emptyState = document.getElementById('my-list-empty-state');
    const counter = document.getElementById('my-list-counter');
    
    counter.textContent = `${myPlaylist.length} título${myPlaylist.length !== 1 ? 's' : ''} salvo${myPlaylist.length !== 1 ? 's' : ''}`;
    
    // Update global clear button behavior
    const clearAllBtn = document.getElementById('my-list-clear-all');
    clearAllBtn.onclick = async () => {
        await clearPlaylist();
        renderMinhaListaPage();
        showToast("Minha lista foi limpa!");
        if (currentOpenItem) updateModalListButton(currentOpenItem.id);
        updateHeroListButton(211684);
    };

    if (myPlaylist.length === 0) {
        emptyState.classList.remove('hidden');
        grid.classList.add('hidden');
        return;
    }
    
    emptyState.classList.add('hidden');
    grid.classList.remove('hidden');
    
    grid.innerHTML = '';
    myPlaylist.forEach(item => {
        const card = document.createElement('div');
        card.className = 'w-full flex flex-col space-y-2 movie-card bg-cardBg rounded-xl overflow-hidden cursor-pointer select-none group relative';
        
        const posterSrc = item.poster_path ? `${IMAGE_BASE_URL}/w300${item.poster_path}` : FALLBACK_POSTER;
        const title = item.title;
        const year = (item.release_date || '').split('-')[0] || 'N/A';
        const rating = item.vote_average ? item.vote_average.toFixed(1) : '0.0';
        
        card.innerHTML = `
            <!-- Thumbnail Wrap -->
            <div class="relative w-full aspect-[2/3] overflow-hidden bg-zinc-900">
                <img src="${posterSrc}" alt="${title}" loading="lazy" class="w-full h-full object-cover">
                <button class="remove-item-btn absolute top-2 right-2 w-8 h-8 rounded-full bg-black/75 hover:bg-red-600 text-white flex items-center justify-center shadow-md transition-colors opacity-0 group-hover:opacity-100 duration-200 z-30" title="Remover da lista">
                    <i class="fa-solid fa-trash-can text-xs"></i>
                </button>
                <div class="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                    <i class="fa-solid fa-play text-white text-lg"></i>
                </div>
            </div>
            <!-- Meta Details -->
            <div class="p-2 sm:p-3 flex flex-col justify-between flex-grow">
                <h4 class="font-bold text-xs sm:text-sm text-white line-clamp-1 group-hover:text-brand transition-colors duration-200" title="${title}">${title}</h4>
                <div class="flex items-center justify-between text-[10px] sm:text-xs text-textSec font-medium mt-1">
                    <span>${year}</span>
                    <span class="flex items-center text-rating">
                        <i class="fa-solid fa-star text-[8px] sm:text-[10px] mr-1"></i>${rating}
                    </span>
                </div>
            </div>
        `;
        
        const removeBtn = card.querySelector('.remove-item-btn');
        removeBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await togglePlaylistItem(item);
            renderMinhaListaPage();
        });
        
        card.addEventListener('click', (e) => {
            if (e.target.closest('.remove-item-btn')) return;
            openDetailsModal(item.id, item.type);
        });
        
        grid.appendChild(card);
    });
}

function initSettingsPage() {
    const tabs = document.querySelectorAll('.config-tab-btn');
    tabs.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabName = btn.getAttribute('data-tab');
            
            tabs.forEach(t => {
                t.className = 'config-tab-btn flex items-center space-x-3 w-full text-left px-3 py-2.5 rounded-lg text-sm font-semibold text-textSec hover:text-white hover:bg-white/5 transition-all duration-150';
            });
            
            btn.className = 'config-tab-btn flex items-center space-x-3 w-full text-left px-3 py-2.5 rounded-lg text-sm font-semibold text-white bg-brand shadow-lg transition-all duration-150';
            
            document.querySelectorAll('[id^="config-tab-"]').forEach(panel => {
                panel.classList.add('hidden');
            });
            
            document.getElementById(`config-tab-${tabName}`).classList.remove('hidden');
        });
    });
    
    const avatarUpload = document.getElementById('avatar-upload');
    if (avatarUpload) {
        avatarUpload.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                if (file.size > 2 * 1024 * 1024) {
                    showToast("Erro: Imagem maior que 2MB.");
                    return;
                }
                const reader = new FileReader();
                reader.onload = async (evt) => {
                    const base64 = evt.target.result;
                    try {
                        const { user } = await apiFetch('/api/auth/profile', {
                            method: 'PUT',
                            body: JSON.stringify({ avatarUrl: base64 })
                        });
                        localStorage.setItem('brflix-user', JSON.stringify(user));
                        
                        document.getElementById('config-avatar-preview').src = base64;
                        const headerAvatars = document.querySelectorAll('#profile-dropdown-btn img');
                        headerAvatars.forEach(img => img.src = base64);
                        
                        showToast("Foto do perfil atualizada!");
                    } catch (err) {
                        showToast(`Erro: ${err.message}`);
                    }
                };
                reader.readAsDataURL(file);
            }
        });
    }
    
    const profileForm = document.getElementById('config-profile-form');
    if (profileForm) {
        profileForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const name = document.getElementById('config-name').value;
            const birth = document.getElementById('config-birth').value;
            
            try {
                const { user } = await apiFetch('/api/auth/profile', {
                    method: 'PUT',
                    body: JSON.stringify({ name, birthDate: birth || null })
                });
                localStorage.setItem('brflix-user', JSON.stringify(user));
                showToast("Alterações salvas com sucesso!");
            } catch (err) {
                showToast(`Erro: ${err.message}`);
            }
        });
    }
    
    const securityForm = document.getElementById('config-security-form');
    if (securityForm) {
        securityForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const currentPass = document.getElementById('config-pass-current').value;
            const newPass = document.getElementById('config-pass-new').value;
            const confirmPass = document.getElementById('config-pass-confirm').value;
            
            if (newPass !== confirmPass) {
                showToast("Erro: Senhas novas não coincidem.");
                return;
            }
            
            try {
                await apiFetch('/api/auth/password', {
                    method: 'PUT',
                    body: JSON.stringify({ currentPassword: currentPass, newPassword: newPass })
                });
                securityForm.reset();
                showToast("Senha atualizada com sucesso!");
            } catch (err) {
                showToast(`Erro: ${err.message}`);
            }
        });
    }
    
    const preferencesForm = document.getElementById('config-preferences-form');
    if (preferencesForm) {
        preferencesForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const lang = document.getElementById('config-lang').value;
            const quality = document.getElementById('config-quality').value;
            
            try {
                const { user } = await apiFetch('/api/auth/profile', {
                    method: 'PUT',
                    body: JSON.stringify({ preferredLanguage: lang, preferredQuality: quality })
                });
                localStorage.setItem('brflix-user', JSON.stringify(user));
                showToast("Preferências salvas!");
            } catch (err) {
                showToast(`Erro: ${err.message}`);
            }
        });
    }

    initSubscriptionTab();
}

/**
 * "Assinatura" tab (server/subscription.js): shows the current plan/status
 * and lets the user start a Mercado Pago checkout (card redirect or Pix QR
 * code) or cancel. Plan prices/features shown here are the static cards in
 * index.html — only the *current status* section is loaded dynamically.
 */
function initSubscriptionTab() {
    const statusNameEl = document.getElementById('subscription-current-plan-name');
    const badgeEl = document.getElementById('subscription-status-badge');
    const devicesEl = document.getElementById('subscription-devices-text');
    const downloadsEl = document.getElementById('subscription-downloads-text');
    const graceWarningEl = document.getElementById('subscription-grace-warning');
    const cancelBtn = document.getElementById('subscription-cancel-btn');
    if (!statusNameEl) return; // Tab markup not present on this page.

    async function loadStatus() {
        if (!getAuthToken()) {
            statusNameEl.textContent = 'Gratuito';
            if (devicesEl) devicesEl.textContent = '1 dispositivo';
            if (downloadsEl) downloadsEl.textContent = '0 downloads';
            if (cancelBtn) cancelBtn.classList.add('hidden');
            return;
        }
        try {
            const status = await apiFetch('/api/subscription/status');
            statusNameEl.textContent = status.plan.name;
            devicesEl.textContent = `${status.devices.active} de ${status.devices.max}`;
            downloadsEl.textContent = status.offlineDownloads.max == null
                ? `${status.offlineDownloads.used} (ilimitado)`
                : `${status.offlineDownloads.used} de ${status.offlineDownloads.max}`;

            const isPaid = status.plan.code !== 'free';
            localStorage.setItem('brflix-is-premium', isPaid ? 'true' : 'false');
            if (isPaid && typeof destroyAllAdElements === 'function') {
                destroyAllAdElements();
            }
            badgeEl.classList.toggle('hidden', !isPaid);
            if (isPaid) {
                badgeEl.textContent = status.subscriptionStatus === 'active' ? 'Ativo' : status.subscriptionStatus;
                badgeEl.className = 'text-[11px] font-bold px-3 py-1 rounded-full uppercase tracking-wider ' +
                    (status.subscriptionStatus === 'active' ? 'bg-green-500/15 text-green-400' : 'bg-yellow-500/15 text-yellow-400');
            }
            cancelBtn.classList.toggle('hidden', !isPaid);

            if (status.graceUntil) {
                const dateStr = new Date(status.graceUntil).toLocaleDateString('pt-BR');
                graceWarningEl.textContent = status.paymentMethod === 'pix'
                    ? `⚠️ Renove seu Pix até ${dateStr} para não perder o Premium.`
                    : `⚠️ Não conseguimos confirmar seu último pagamento. Regularize até ${dateStr} para não perder o Premium.`;
                graceWarningEl.classList.remove('hidden');
            } else {
                graceWarningEl.classList.add('hidden');
            }
        } catch (err) {
            statusNameEl.textContent = 'Não foi possível carregar';
        }
    }

    loadStatus();

    if (isSubscriptionTabInitialized) return;

    document.querySelectorAll('.subscription-choose-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const planCode = btn.getAttribute('data-plan-code');
            const method = btn.getAttribute('data-method');
            const originalText = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            try {
                // Card and Pix both go through Mercado Pago's hosted Checkout Pro —
                // Pix as a preference restricted to just that payment type (see
                // server/mercadopago.js) — so both simply redirect to initPoint.
                const result = await apiFetch('/api/subscription/checkout', {
                    method: 'POST',
                    body: JSON.stringify({ planCode, method }),
                });
                window.location.href = result.initPoint;
            } catch (err) {
                showToast(`Erro: ${err.message}`);
            } finally {
                btn.disabled = false;
                btn.innerHTML = originalText;
            }
        });
    });

    if (cancelBtn) {
        cancelBtn.addEventListener('click', async () => {
            if (!confirm('Tem certeza que deseja cancelar sua assinatura? Você voltará ao plano gratuito (com anúncios).')) return;
            try {
                await apiFetch('/api/subscription/cancel', { method: 'POST' });
                showToast('Assinatura cancelada.');
                loadStatus();
            } catch (err) {
                showToast(`Erro: ${err.message}`);
            }
        });
    }

    isSubscriptionTabInitialized = true;
}

function renderConfiguracoesPage() {
    const currentUser = JSON.parse(localStorage.getItem('brflix-user'));
    if (!currentUser) return;
    
    document.getElementById('config-name').value = currentUser.name || '';
    document.getElementById('config-email').value = currentUser.email || '';
    // Email changes aren't supported via the profile form (it's the account's unique identifier)
    document.getElementById('config-email').setAttribute('disabled', 'true');
    document.getElementById('config-birth').value = currentUser.birth_date ? currentUser.birth_date.split('T')[0] : '';
    
    if (currentUser.avatar_url) {
        document.getElementById('config-avatar-preview').src = currentUser.avatar_url;
    }
    
    document.getElementById('config-lang').value = currentUser.preferred_language || 'pt';
    document.getElementById('config-quality').value = currentUser.preferred_quality || 'auto';
}

function initAuth() {
    const toggleLoginPass = document.getElementById('toggle-login-pass');
    const loginPassInput = document.getElementById('login-password');
    if (toggleLoginPass && loginPassInput) {
        toggleLoginPass.addEventListener('click', () => {
            const isPass = loginPassInput.getAttribute('type') === 'password';
            loginPassInput.setAttribute('type', isPass ? 'text' : 'password');
            toggleLoginPass.innerHTML = `<i class="fa-solid ${isPass ? 'fa-eye-slash' : 'fa-eye'}"></i>`;
        });
    }
    
    const toggleCadastroPass = document.getElementById('toggle-cadastro-pass');
    const cadastroPassInput = document.getElementById('cadastro-password');
    if (toggleCadastroPass && cadastroPassInput) {
        toggleCadastroPass.addEventListener('click', () => {
            const isPass = cadastroPassInput.getAttribute('type') === 'password';
            cadastroPassInput.setAttribute('type', isPass ? 'text' : 'password');
            toggleCadastroPass.innerHTML = `<i class="fa-solid ${isPass ? 'fa-eye-slash' : 'fa-eye'}"></i>`;
        });
    }
    
    if (cadastroPassInput) {
        cadastroPassInput.addEventListener('input', (e) => {
            const pass = e.target.value;
            const bar = document.getElementById('password-strength-bar');
            const strengthText = document.getElementById('password-strength-text');
            
            let score = 0;
            if (pass.length > 5) score++;
            if (/[A-Z]/.test(pass)) score++;
            if (/[0-9]/.test(pass)) score++;
            if (/[^A-Za-z0-9]/.test(pass)) score++;
            
            bar.className = 'h-full rounded-full transition-all duration-300 ';
            if (score === 0) {
                bar.style.width = '0%';
                strengthText.textContent = 'Digite uma senha';
            } else if (score === 1) {
                bar.style.width = '25%';
                bar.classList.add('bg-red-500');
                strengthText.textContent = 'Força da senha: Fraca';
            } else if (score === 2) {
                bar.style.width = '50%';
                bar.classList.add('bg-yellow-500');
                strengthText.textContent = 'Força da senha: Média';
            } else if (score === 3) {
                bar.style.width = '75%';
                bar.classList.add('bg-blue-500');
                strengthText.textContent = 'Força da senha: Boa';
            } else {
                bar.style.width = '100%';
                bar.classList.add('bg-green-500');
                strengthText.textContent = 'Força da senha: Forte';
            }
        });
    }
    
    const cadastroForm = document.getElementById('cadastro-form');
    if (cadastroForm) {
        cadastroForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const name = document.getElementById('cadastro-name').value;
            const email = document.getElementById('cadastro-email').value;
            const password = document.getElementById('cadastro-password').value;
            const confirmPassword = document.getElementById('cadastro-confirm-password').value;
            
            const emailErr = document.getElementById('cadastro-email-error');
            const confirmErr = document.getElementById('cadastro-confirm-error');
            
            emailErr.classList.add('hidden');
            confirmErr.classList.add('hidden');
            
            if (password !== confirmPassword) {
                confirmErr.classList.remove('hidden');
                return;
            }
            
            if (password.length < 6) {
                showToast("Erro: Senha muito curta!");
                return;
            }
            
            try {
                const { user, token } = await apiFetch('/api/auth/register', {
                    method: 'POST',
                    body: JSON.stringify({ name, email, password })
                });
                
                localStorage.setItem('brflix-token', token);
                localStorage.setItem('brflix-user', JSON.stringify(user));
                
                showToast("Conta criada com sucesso!");
                updateHeaderAvatar();
                await loadPlaylist();
                renderPlaylist();
                initCalendarNotifications();
                
                setTimeout(() => {
                    window.location.hash = '#/';
                }, 1000);
            } catch (err) {
                if (/e-mail/i.test(err.message)) {
                    emailErr.textContent = err.message;
                    emailErr.classList.remove('hidden');
                } else {
                    showToast(`Erro: ${err.message}`);
                }
            }
        });
    }
    
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('login-email').value;
            const password = document.getElementById('login-password').value;
            
            const emailErr = document.getElementById('login-email-error');
            const passErr = document.getElementById('login-password-error');
            
            emailErr.classList.add('hidden');
            passErr.classList.add('hidden');
            
            try {
                const result = await apiFetch('/api/auth/login', {
                    method: 'POST',
                    body: JSON.stringify({ email, password })
                });

                if (result.twoFactorRequired) {
                    // Password was correct but this account has 2FA enabled —
                    // switch to the code-entry screen instead of completing the
                    // login yet (mirrors the admin panel's login flow).
                    pendingLogin2faToken = result.pendingToken;
                    document.getElementById('login-form-view').classList.add('hidden');
                    document.getElementById('login-2fa-view').classList.remove('hidden');
                    const codeInput = document.getElementById('login-2fa-code');
                    codeInput.value = '';
                    codeInput.focus();
                    return;
                }

                const { user, token } = result;
                localStorage.setItem('brflix-token', token);
                localStorage.setItem('brflix-user', JSON.stringify(user));
                showToast(`Bem-vindo, ${user.name}!`);
                
                updateHeaderAvatar();
                await loadPlaylist();
                renderPlaylist();
                initCalendarNotifications();
                
                setTimeout(() => {
                    window.location.hash = '#/';
                }, 1000);
            } catch (err) {
                if (/senha/i.test(err.message)) {
                    passErr.textContent = err.message;
                    passErr.classList.remove('hidden');
                } else {
                    emailErr.textContent = err.message;
                    emailErr.classList.remove('hidden');
                }
            }
        });
    }

    // Step 2 of login: 6-digit authenticator code, only reached when the
    // account above has 2FA enabled (see twoFactorRequired handling above).
    let pendingLogin2faToken = null;
    const login2faForm = document.getElementById('login-2fa-form');
    if (login2faForm) {
        login2faForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const code = document.getElementById('login-2fa-code').value.trim();
            const codeErr = document.getElementById('login-2fa-error');
            codeErr.classList.add('hidden');

            try {
                const { user, token } = await apiFetch('/api/auth/login/2fa', {
                    method: 'POST',
                    body: JSON.stringify({ pendingToken: pendingLogin2faToken, code })
                });
                pendingLogin2faToken = null;
                localStorage.setItem('brflix-token', token);
                localStorage.setItem('brflix-user', JSON.stringify(user));
                showToast(`Bem-vindo, ${user.name}!`);

                updateHeaderAvatar();
                await loadPlaylist();
                renderPlaylist();
                initCalendarNotifications();

                setTimeout(() => {
                    window.location.hash = '#/';
                }, 1000);
            } catch (err) {
                codeErr.textContent = err.message;
                codeErr.classList.remove('hidden');
            }
        });
    }

    const login2faCancelBtn = document.getElementById('login-2fa-cancel');
    if (login2faCancelBtn) {
        login2faCancelBtn.addEventListener('click', () => {
            pendingLogin2faToken = null;
            document.getElementById('login-2fa-view').classList.add('hidden');
            document.getElementById('login-form-view').classList.remove('hidden');
            const passwordInput = document.getElementById('login-password');
            if (passwordInput) passwordInput.value = '';
        });
    }
    
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            try {
                await apiFetch('/api/auth/logout', { method: 'POST' });
            } catch (err) {
                console.warn('[Auth] Logout request failed (clearing local session anyway):', err.message);
            }
            localStorage.removeItem('brflix-token');
            localStorage.removeItem('brflix-user');
            const headerAvatars = document.querySelectorAll('#profile-dropdown-btn img');
            headerAvatars.forEach(img => img.src = `${UNSPLASH_PROXY_BASE}/photo-1534528741775-53994a69daeb?q=80&width=100&auto=format&fit=crop`);
            
            // Clear the previous account's list from memory/UI — it belongs to that
            // account's server-side favorites, not this (now signed-out) session.
            myPlaylist = [];
            renderPlaylist();
            
            // Sync continue watching section visibility on logout
            initContinueWatching();
            initCalendarNotifications();
            
            showToast("Você saiu do BRFLIX.");
            setTimeout(() => {
                window.location.hash = '#/login';
            }, 800);
        });
    }
}

function updateHeaderAvatar() {
    const currentUser = JSON.parse(localStorage.getItem('brflix-user') || 'null');
    if (currentUser && currentUser.avatar_url) {
        const headerAvatars = document.querySelectorAll('#profile-dropdown-btn img');
        headerAvatars.forEach(img => img.src = currentUser.avatar_url);
    }
    // Update continue watching layout/content based on login status
    initContinueWatching();
}

/**
 * EXPOSE ACTIONS GLOBALLY FOR INLINE ONCLICK EVENTS
 */
window.scrollCarousel = function(carouselId, offset) {
    const el = document.getElementById(carouselId);
    if (el) {
        el.scrollBy({ left: offset, behavior: 'smooth' });
    }
};

window.openDetailsModal = openDetailsModal;
window.playMedia = playMedia;
window.togglePlaylistItem = togglePlaylistItem;

/**
 * BRFLIX Smart TV / Chromecast / AirPlay Casting Manager
 */
function initCastSystem() {
    const headerCastBtn = document.getElementById('header-cast-btn');
    const nativeCastBtn = document.getElementById('native-cast-btn');
    const castModal = document.getElementById('cast-tv-modal');
    const closeCastModalBtn = document.getElementById('close-cast-modal-btn');
    const dismissCastModalBtn = document.getElementById('dismiss-cast-modal-btn');
    const castStartStreamBtn = document.getElementById('cast-start-stream-btn');
    const playerNative = document.getElementById('player-native');

    // Initialize Google Cast SDK context when API becomes available
    window.__onGCastApiAvailable = function(isAvailable) {
        if (isAvailable && window.cast && window.cast.framework) {
            try {
                const receiverId = (window.chrome && window.chrome.cast && window.chrome.cast.media && window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID)
                    ? window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID
                    : 'CC1AD845';
                const autoJoin = (window.chrome && window.chrome.cast && window.chrome.cast.AutoJoinPolicy && window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED)
                    ? window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
                    : (window.chrome && window.chrome.cast && window.chrome.cast.AUTO_JOIN_POLICY ? window.chrome.cast.AUTO_JOIN_POLICY.ORIGIN_SCOPED : 'origin_scoped');

                cast.framework.CastContext.getInstance().setOptions({
                    receiverApplicationId: receiverId,
                    autoJoinPolicy: autoJoin
                });
            } catch (e) {
                console.log('[Cast] Google Cast init note:', e);
            }
        }
    };

    function triggerCastDevicePicker() {
        // 1. Apple AirPlay (Safari iOS / Mac)
        if (playerNative && typeof playerNative.webkitShowPlaybackTargetPicker === 'function') {
            try {
                playerNative.webkitShowPlaybackTargetPicker();
                return true;
            } catch (e) {
                console.log('[Cast] AirPlay picker note:', e);
            }
        }

        // 2. Google Cast (Chromecast / Google TV / Android TV)
        if (window.cast && window.cast.framework) {
            try {
                const context = cast.framework.CastContext.getInstance();
                context.requestSession();
                return true;
            } catch (e) {
                console.log('[Cast] Google Cast session request note:', e);
            }
        }

        // 3. W3C Presentation API (Chrome / Edge / Opera / Samsung Internet)
        if (window.PresentationRequest) {
            try {
                const request = new PresentationRequest(['https://www.google.com/chromecast']);
                request.start();
                return true;
            } catch (e) {
                console.log('[Cast] Presentation request note:', e);
            }
        }

        return false;
    }

    function openCastModal() {
        if (castModal) {
            castModal.classList.remove('hidden');
        }
    }

    function closeCastModal() {
        if (castModal) {
            castModal.classList.add('hidden');
        }
    }

    function handleCastClick(e) {
        if (e) e.stopPropagation();
        triggerCastDevicePicker();
        openCastModal();
    }

    if (headerCastBtn) headerCastBtn.addEventListener('click', handleCastClick);
    if (nativeCastBtn) nativeCastBtn.addEventListener('click', handleCastClick);

    if (closeCastModalBtn) closeCastModalBtn.addEventListener('click', closeCastModal);
    if (dismissCastModalBtn) dismissCastModalBtn.addEventListener('click', closeCastModal);

    if (castStartStreamBtn) {
        castStartStreamBtn.addEventListener('click', () => {
            const launched = triggerCastDevicePicker();
            if (!launched) {
                showToast("📡 Conecte sua TV e seu celular no mesmo Wi-Fi para transmitir.");
            }
        });
    }

    if (castModal) {
        castModal.addEventListener('click', (e) => {
            if (e.target === castModal) closeCastModal();
        });
    }
}

// Initialize Cast controls on DOM ready
/**
 * BRFLIX Screen Limit Reached Modal Manager
 */
function getOrCreateScreenLimitModal() {
    let modal = document.getElementById('screen-limit-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'screen-limit-modal';
        modal.className = 'fixed inset-0 z-[2147483647] hidden bg-black/85 backdrop-blur-md flex items-center justify-center p-4';
        modal.innerHTML = `
            <div class="bg-cardBg border border-white/15 rounded-3xl p-6 sm:p-8 max-w-md w-full shadow-2xl relative space-y-6 text-center">
                <button id="close-screen-limit-modal-btn" class="absolute top-5 right-5 text-textSec hover:text-white text-xl transition-colors">
                    <i class="fa-solid fa-xmark"></i>
                </button>
                
                <div class="w-16 h-16 rounded-2xl bg-amber-500/15 border border-amber-500/30 text-amber-400 text-3xl flex items-center justify-center mx-auto shadow-lg">
                    <i class="fa-solid fa-desktop"></i>
                </div>

                <div class="space-y-2">
                    <h3 class="text-2xl font-bold text-white font-condensed tracking-wide uppercase">Limite de Telas Atingido</h3>
                    <p id="screen-limit-modal-msg" class="text-xs sm:text-sm text-textSec leading-relaxed">
                        Você já está assistindo no BRFLIX em outro dispositivo. Seu plano atual permite apenas 1 tela simultânea.
                    </p>
                </div>

                <div class="bg-bgSec/80 border border-white/10 rounded-2xl p-4 text-xs text-textSec space-y-2 text-left">
                    <div class="font-bold text-white uppercase text-[11px] tracking-wider flex items-center gap-1.5 border-b border-white/10 pb-1.5">
                        <i class="fa-solid fa-gem text-brand"></i> O que você pode fazer:
                    </div>
                    <p>• Pare a reprodução no outro aparelho para assistir aqui.</p>
                    <p>• Ou faça upgrade para assistir em 2 ou 4 telas simultâneas com a família!</p>
                </div>

                <div class="flex flex-col gap-2.5">
                    <a href="#/assinatura" id="screen-limit-upgrade-btn" class="w-full bg-brand hover:bg-brand-light text-white font-bold py-3.5 rounded-xl text-xs sm:text-sm uppercase tracking-wider transition-all duration-200 shadow-lg shadow-brand/20 active:scale-95 flex items-center justify-center gap-2">
                        <i class="fa-solid fa-arrow-up-right-dots"></i>
                        <span>Ver Planos com Mais Telas</span>
                    </a>
                    <button id="dismiss-screen-limit-modal-btn" class="w-full bg-white/5 hover:bg-white/10 text-white/70 font-semibold py-2.5 rounded-xl text-xs transition-colors">
                        Entendi, assistir depois
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }
    initScreenLimitModal();
    return modal;
}

function showScreenLimitModal(message) {
    if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
    }
    if (playerNative) {
        playerNative.pause();
        playerNative.removeAttribute('src');
    }
    if (playerIframe) {
        playerIframe.removeAttribute('src');
    }
    if (playerModal) {
        playerModal.classList.add('hidden');
    }
    document.body.classList.remove('overflow-hidden', 'in-player-mode');
    restoreFloatingAds();
    isPlayerWatching = false;

    const modal = getOrCreateScreenLimitModal();
    if (modal.parentElement !== document.body) {
        document.body.appendChild(modal);
    }
    modal.classList.remove('hidden');
    modal.style.setProperty('display', 'flex', 'important');
    modal.style.setProperty('z-index', '2147483647', 'important');
    modal.style.setProperty('visibility', 'visible', 'important');
    modal.style.setProperty('opacity', '1', 'important');

    const msgEl = document.getElementById('screen-limit-modal-msg');
    if (msgEl && message) {
        msgEl.textContent = message;
    }
    showToast(message || 'Limite de 1 tela simultânea atingido.');
}

function initScreenLimitModal() {
    const modal = document.getElementById('screen-limit-modal');
    if (!modal) return;
    const closeBtn = document.getElementById('close-screen-limit-modal-btn');
    const dismissBtn = document.getElementById('dismiss-screen-limit-modal-btn');
    const upgradeBtn = document.getElementById('screen-limit-upgrade-btn');

    function closeModal() {
        modal.classList.add('hidden');
        modal.style.setProperty('display', 'none', 'important');
    }

    if (closeBtn) closeBtn.onclick = closeModal;
    if (dismissBtn) dismissBtn.onclick = closeModal;
    if (upgradeBtn) {
        upgradeBtn.onclick = () => {
            closeModal();
            window.location.hash = '#/assinatura';
        };
    }
    modal.onclick = (e) => {
        if (e.target === modal) closeModal();
    };
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        initCastSystem();
        initScreenLimitModal();
    });
} else {
    initCastSystem();
    initScreenLimitModal();
}
