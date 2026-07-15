// ==UserScript==
// @name         Bilibili Smart CDN + Adaptive Prefetch
// @namespace    https://github.com/AchelousDev
// @version      0.9.3
// @description  Improves Bilibili high-bitrate playback with smart CDN selection and adaptive media prefetching.
// @author       AchelousDev
// @license      MIT
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/bangumi/play/*
// @icon         https://www.bilibili.com/favicon.ico
// @homepageURL  https://github.com/AchelousDev/bilibili-smart-cdn
// @supportURL   https://github.com/AchelousDev/bilibili-smart-cdn/issues
// @updateURL    https://raw.githubusercontent.com/AchelousDev/bilibili-smart-cdn/main/Bilibili-CDN-Smart-Selector.user.js
// @downloadURL  https://raw.githubusercontent.com/AchelousDev/bilibili-smart-cdn/main/Bilibili-CDN-Smart-Selector.user.js
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const PLUGIN = '[BiliSmartCDN]';
    const VERSION = '0.9.3';

    const AVOID_HOSTS = new Set([
        'upos-sz-mirrorcosov.bilivideo.com',
    ]);

    const PREFERRED_BACKUP_HOSTS = [
        'upos-hz-mirrorakam.akamaized.net',
        'upos-sz-mirrorhw.bilivideo.com',
        'upos-sz-mirroraliov.bilivideo.com',
        'upos-sz-mirrorali.bilivideo.com',
        'upos-sz-mirrorcos.bilivideo.com',
    ];

    const DEBUG_MONITOR = false;

    /*
     * 额外预取目标。
     */
    const TARGET_VIDEO_RESERVE_SECONDS = 120;
    const TARGET_AUDIO_RESERVE_SECONDS = 150;

    /*
     * Range 分块大小。
     */
    const VIDEO_CHUNK_BYTES = 8 * 1024 * 1024;
    const AUDIO_CHUNK_BYTES = 1 * 1024 * 1024;

    /*
     * 预取硬限制。
     */
    const MAX_VIDEO_RESERVE_BYTES = 160 * 1024 * 1024;
    const MAX_AUDIO_RESERVE_BYTES = 8 * 1024 * 1024;

    const MAX_VIDEO_TOPUP_PER_PAUSE = 96 * 1024 * 1024;
    const MAX_AUDIO_TOPUP_PER_PAUSE = 4 * 1024 * 1024;

    /*
     * 缺口太小时不进行补仓。
     */
    const MIN_VIDEO_TOPUP_BYTES = 4 * 1024 * 1024;
    const MIN_AUDIO_TOPUP_BYTES = 256 * 1024;

    const VIDEO_BANDWIDTH_THRESHOLD = 500_000;

    const PAUSE_PREFETCH_DELAY_MS = 1800;
    const PREFETCH_COOLDOWN_MS = 10_000;
    const MONITOR_INTERVAL_MS = 1000;

    /*
     * 单个 Range 请求的超时和重试限制。
     */
    const RANGE_REQUEST_TIMEOUT_MS = 15_000;
    const RANGE_REQUEST_MAX_RETRIES = 1;

    /*
     * 接近 1 GB 的请求可能是探测 Range。
     */
    const SUSPICIOUS_RANGE_START = 900_000_000;
    const MAX_REASONABLE_RANGE_JUMP = 256 * 1024 * 1024;

    /*
     * 手动拖动进度后的宽限时间。
     */
    const SEEK_GRACE_MS = 8_000;

    let currentVideo = null;
    let monitorBox = null;
    let monitorTimer = null;

    let pauseSessionId = 0;
    let prefetchAbortController = null;
    let prefetchRunning = false;
    let lastPrefetchAt = 0;

    let currentBatchVideoBytes = 0;
    let currentBatchAudioBytes = 0;
    let lastPrefetchMessage = 'Idle';

    let seekGraceUntil = 0;

    /*
     * 用户 seek 后，视频和音频都需要重新接受一个 Range
     * 作为新播放位置基准。
     */
    const pendingSeekBaseline = {
        video: false,
        audio: false,
    };

    const activeMedia = {
        video: null,
        audio: null,
    };

    /*
     * 每个完整签名 URL 对应独立媒体状态。
     */
    const mediaStateByUrl = new Map();

    function log(...args) {
        console.log(PLUGIN, ...args);
    }

    function warn(...args) {
        console.warn(PLUGIN, ...args);
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function getHost(url) {
        if (!url || typeof url !== 'string') {
            return '';
        }

        try {
            return new URL(url).hostname;
        } catch {
            return '';
        }
    }

    function getBandwidthFromUrl(url) {
        try {
            return Number(
                new URL(url).searchParams.get('bw') || 0
            );
        } catch {
            return 0;
        }
    }

    function classifyMediaUrl(url) {
        return getBandwidthFromUrl(url) >= VIDEO_BANDWIDTH_THRESHOLD
            ? 'video'
            : 'audio';
    }

    function isM4sUrl(url) {
        return (
            typeof url === 'string' &&
            url.includes('.m4s')
        );
    }

    function getBaseUrl(item) {
        return item?.base_url || item?.baseUrl || '';
    }

    function getBackupUrls(item) {
        const urls = [
            ...(Array.isArray(item?.backup_url)
                ? item.backup_url
                : []),

            ...(Array.isArray(item?.backupUrl)
                ? item.backupUrl
                : []),
        ];

        return urls.filter(
            (url, index, array) =>
                typeof url === 'string' &&
                url.length > 0 &&
                array.indexOf(url) === index
        );
    }

    function getAllCandidateUrls(item) {
        const urls = [
            getBaseUrl(item),
            ...getBackupUrls(item),
        ].filter(Boolean);

        return urls.filter(
            (url, index, array) =>
                array.indexOf(url) === index
        );
    }

    function pickBestUrl(item) {
        const originalUrl = getBaseUrl(item);
        const originalHost = getHost(originalUrl);
        const candidates = getAllCandidateUrls(item);

        if (
            originalUrl &&
            originalHost &&
            !AVOID_HOSTS.has(originalHost)
        ) {
            return originalUrl;
        }

        for (const preferredHost of PREFERRED_BACKUP_HOSTS) {
            const match = candidates.find(
                url => getHost(url) === preferredHost
            );

            if (match) {
                return match;
            }
        }

        const nonAvoidedCandidate = candidates.find(url => {
            const host = getHost(url);

            return (
                host &&
                !AVOID_HOSTS.has(host)
            );
        });

        return (
            nonAvoidedCandidate ||
            originalUrl ||
            candidates[0] ||
            ''
        );
    }

    function transformDashItem(item, type) {
        if (!item) {
            return;
        }

        const oldUrl = getBaseUrl(item);
        const oldHost = getHost(oldUrl);

        const selectedUrl = pickBestUrl(item);
        const newHost = getHost(selectedUrl);

        if (!selectedUrl) {
            warn(`${type} stream has no usable URL`);
            return;
        }

        /*
         * 保留完整签名 URL，不做单纯 hostname 替换。
         */
        item.base_url = selectedUrl;
        item.baseUrl = selectedUrl;

        if (oldHost !== newHost) {
            log(
                `${type} CDN changed:`,
                oldHost,
                '=>',
                newHost
            );
        }
    }

    function getVideoInfo(playInfo) {
        if (!playInfo || typeof playInfo !== 'object') {
            return null;
        }

        if (playInfo.data?.dash) {
            return playInfo.data;
        }

        if (playInfo.data?.video_info?.dash) {
            return playInfo.data.video_info;
        }

        if (playInfo.result?.dash) {
            return playInfo.result;
        }

        if (playInfo.result?.video_info?.dash) {
            return playInfo.result.video_info;
        }

        return null;
    }

    function transformPlayInfo(playInfo) {
        if (!playInfo) {
            return playInfo;
        }

        try {
            const videoInfo = getVideoInfo(playInfo);

            if (!videoInfo?.dash) {
                return playInfo;
            }

            if (Array.isArray(videoInfo.dash.video)) {
                log(
                    'video streams preserved:',
                    videoInfo.dash.video.length
                );

                videoInfo.dash.video.forEach(item => {
                    transformDashItem(item, 'video');
                });
            }

            if (Array.isArray(videoInfo.dash.audio)) {
                log(
                    'audio streams preserved:',
                    videoInfo.dash.audio.length
                );

                videoInfo.dash.audio.forEach(item => {
                    transformDashItem(item, 'audio');
                });
            }

            return playInfo;
        } catch (error) {
            warn(
                'transformPlayInfo failed:',
                error
            );

            return playInfo;
        }
    }

    function shouldInterceptPlayUrl(url) {
        if (!url) {
            return false;
        }

        const value =
            typeof url === 'string'
                ? url
                : String(url);

        return (
            value.includes('/x/player/wbi/playurl') ||
            value.includes('/x/player/playurl') ||
            value.includes('/pgc/player/web/v2/playurl') ||
            value.includes('/pgc/player/web/playurl') ||
            value.includes('/pugv/player/web/playurl')
        );
    }

    function parseRangeHeader(value) {
        if (!value) {
            return null;
        }

        const match = String(value).match(
            /bytes\s*=\s*(\d+)-(\d*)/i
        );

        if (!match) {
            return null;
        }

        return {
            start: Number(match[1]),

            end:
                match[2]
                    ? Number(match[2])
                    : null,
        };
    }

    function parseContentRange(value) {
        if (!value) {
            return null;
        }

        const match = String(value).match(
            /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i
        );

        if (!match) {
            return null;
        }

        return {
            start: Number(match[1]),
            end: Number(match[2]),

            total:
                match[3] === '*'
                    ? null
                    : Number(match[3]),
        };
    }

    function parseUnsatisfiedContentRange(value) {
        if (!value) {
            return null;
        }

        const match = String(value).match(
            /bytes\s+\*\/(\d+)/i
        );

        if (!match) {
            return null;
        }

        return {
            total: Number(match[1]),
        };
    }

    function getOrCreateMediaState(url) {
        let state = mediaStateByUrl.get(url);

        if (!state) {
            state = {
                observedEnd: -1,
                prefetchedEnd: -1,
                nextStart: 0,
                total: null,
                lastSeen: 0,
            };

            mediaStateByUrl.set(url, state);
        }

        return state;
    }

    function updateMediaCursor(url) {
        const state =
            getOrCreateMediaState(url);

        state.nextStart = Math.max(
            state.nextStart,
            state.observedEnd + 1,
            state.prefetchedEnd + 1,
            0
        );

        if (Number.isFinite(state.total)) {
            state.nextStart = Math.min(
                state.nextStart,
                state.total
            );
        }

        return state;
    }

    function getReserveBytes(state) {
        if (!state) {
            return 0;
        }

        return Math.max(
            0,
            state.prefetchedEnd -
            state.observedEnd
        );
    }

    function bytesForSeconds(
        bandwidth,
        seconds
    ) {
        if (
            !Number.isFinite(bandwidth) ||
            bandwidth <= 0 ||
            !Number.isFinite(seconds) ||
            seconds <= 0
        ) {
            return 0;
        }

        return Math.ceil(
            bandwidth *
            seconds /
            8
        );
    }

    function reserveSeconds(
        state,
        bandwidth
    ) {
        if (
            !state ||
            !Number.isFinite(bandwidth) ||
            bandwidth <= 0
        ) {
            return 0;
        }

        return (
            getReserveBytes(state) *
            8 /
            bandwidth
        );
    }

    function roundUpToChunk(
        bytes,
        chunkBytes
    ) {
        if (bytes <= 0) {
            return 0;
        }

        return (
            Math.ceil(
                bytes /
                chunkBytes
            ) *
            chunkBytes
        );
    }

    function calculateTopUpPlan({
        state,
        bandwidth,
        targetSeconds,
        maxReserveBytes,
        maxTopUpBytes,
        minTopUpBytes,
        chunkBytes,
    }) {
        const reserveBytes =
            getReserveBytes(state);

        const rawTargetBytes =
            bytesForSeconds(
                bandwidth,
                targetSeconds
            );

        const targetBytes = clamp(
            rawTargetBytes,
            chunkBytes,
            maxReserveBytes
        );

        const missingBytes =
            Math.max(
                0,
                targetBytes -
                reserveBytes
            );

        if (
            missingBytes <
            minTopUpBytes
        ) {
            return {
                reserveBytes,
                targetBytes,
                topUpBytes: 0,
            };
        }

        const roundedTopUp =
            roundUpToChunk(
                missingBytes,
                chunkBytes
            );

        return {
            reserveBytes,
            targetBytes,

            topUpBytes:
                Math.min(
                    roundedTopUp,
                    maxTopUpBytes
                ),
        };
    }

    function isSuspiciousRange(
        state,
        requestRange
    ) {
        if (
            !requestRange ||
            !Number.isFinite(
                requestRange.start
            )
        ) {
            return false;
        }

        /*
         * 用户主动 seek 的宽限期内，
         * 不按照跳跃距离判定异常。
         */
        const inSeekGracePeriod =
            Date.now() <=
            seekGraceUntil;

        if (
            requestRange.start >=
            SUSPICIOUS_RANGE_START
        ) {
            return true;
        }

        if (
            !inSeekGracePeriod &&
            state.observedEnd >= 0 &&
            requestRange.start >
                state.observedEnd +
                MAX_REASONABLE_RANGE_JUMP
        ) {
            return true;
        }

        if (
            Number.isFinite(state.total) &&
            requestRange.start >=
                state.total
        ) {
            return true;
        }

        return false;
    }

    function recordObservedMediaRange(
        url,
        requestRange,
        status
    ) {
        if (!isM4sUrl(url)) {
            return;
        }

        if (
            status !== 206 &&
            status !== 200
        ) {
            return;
        }

        if (!requestRange) {
            return;
        }

        const type =
            classifyMediaUrl(url);

        const state =
            getOrCreateMediaState(url);

        const end =
            Number.isFinite(
                requestRange.end
            )
                ? requestRange.end
                : requestRange.start;

        /*
         * 用户刚刚手动拖动进度条。
         * 接受该媒体类型的第一个合理 Range
         * 作为新的播放位置基准。
         */
        if (
            pendingSeekBaseline[type] &&
            Date.now() <= seekGraceUntil &&
            requestRange.start <
                SUSPICIOUS_RANGE_START
        ) {
            state.observedEnd = end;

            /*
             * 旧位置预取的缓存不能继续计入新位置 reserve。
             */
            state.prefetchedEnd = -1;
            state.nextStart = end + 1;
            state.lastSeen = Date.now();

            pendingSeekBaseline[type] = false;

            activeMedia[type] = {
                url,
                bandwidth:
                    getBandwidthFromUrl(url),
                lastSeen:
                    Date.now(),
            };

            log(
                `${type} seek baseline accepted:`,
                {
                    host:
                        getHost(url),

                    start:
                        requestRange.start,

                    end,

                    bandwidth:
                        getBandwidthFromUrl(url),

                    nextStart:
                        state.nextStart,
                }
            );

            return;
        }

        if (
            requestRange.start >=
            SUSPICIOUS_RANGE_START
        ) {
            log(
                'ignored suspicious media Range:',
                {
                    type,
                    start:
                        requestRange.start,

                    end:
                        requestRange.end,

                    observedEnd:
                        state.observedEnd,

                    total:
                        state.total,

                    reason:
                        'probe-range',
                }
            );

            return;
        }

        const inSeekGracePeriod =
            Date.now() <=
            seekGraceUntil;

        if (
            !inSeekGracePeriod &&
            state.observedEnd >= 0 &&
            requestRange.start >
                state.observedEnd +
                MAX_REASONABLE_RANGE_JUMP
        ) {
            log(
                'ignored suspicious media Range:',
                {
                    type,
                    start:
                        requestRange.start,

                    end:
                        requestRange.end,

                    observedEnd:
                        state.observedEnd,

                    total:
                        state.total,

                    reason:
                        'large-unexpected-jump',
                }
            );

            return;
        }

        if (
            Number.isFinite(state.total) &&
            requestRange.start >=
                state.total
        ) {
            log(
                'ignored suspicious media Range:',
                {
                    type,
                    start:
                        requestRange.start,

                    end:
                        requestRange.end,

                    observedEnd:
                        state.observedEnd,

                    total:
                        state.total,

                    reason:
                        'outside-file',
                }
            );

            return;
        }

        state.observedEnd =
            Math.max(
                state.observedEnd,
                end
            );

        state.lastSeen =
            Date.now();

        updateMediaCursor(url);

        const existing =
            activeMedia[type];

        if (
            !existing ||
            existing.url !== url
        ) {
            activeMedia[type] = {
                url,
                bandwidth:
                    getBandwidthFromUrl(url),
                lastSeen:
                    Date.now(),
            };

            log(
                `${type} media detected:`,
                {
                    host:
                        getHost(url),

                    bandwidth:
                        getBandwidthFromUrl(url),

                    observedEnd:
                        state.observedEnd,

                    nextStart:
                        state.nextStart,
                }
            );
        } else {
            existing.lastSeen =
                Date.now();
        }
    }

    /*
     * 保存原始 fetch，脚本自己的 Range 预取直接使用它。
     */
    const originalFetch =
        unsafeWindow.fetch;

    if (
        typeof originalFetch ===
        'function'
    ) {
        unsafeWindow.fetch =
            function (
                input,
                init
            ) {
                const requestUrl =
                    typeof input ===
                    'string'
                        ? input
                        : input?.url;

                return originalFetch
                    .call(
                        this,
                        input,
                        init
                    )
                    .then(
                        async response => {
                            if (
                                !shouldInterceptPlayUrl(
                                    requestUrl
                                )
                            ) {
                                return response;
                            }

                            try {
                                const text =
                                    await response
                                        .clone()
                                        .text();

                                const json =
                                    JSON.parse(text);

                                transformPlayInfo(
                                    json
                                );

                                const headers =
                                    new Headers(
                                        response.headers
                                    );

                                headers.delete(
                                    'content-length'
                                );

                                headers.delete(
                                    'content-encoding'
                                );

                                return new Response(
                                    JSON.stringify(
                                        json
                                    ),
                                    {
                                        status:
                                            response.status,

                                        statusText:
                                            response.statusText,

                                        headers,
                                    }
                                );
                            } catch (error) {
                                warn(
                                    'fetch playurl intercept failed:',
                                    error
                                );

                                return response;
                            }
                        }
                    );
            };
    }

    /*
     * XHR 拦截：
     * 1. 修改 playurl JSON
     * 2. 记录播放器实际 Range
     */
    const OriginalXHR =
        unsafeWindow.XMLHttpRequest;

    if (OriginalXHR) {
        unsafeWindow.XMLHttpRequest =
            class BiliSmartXHR
                extends OriginalXHR {

                open(
                    method,
                    url,
                    ...rest
                ) {
                    this._biliSmartUrl =
                        typeof url ===
                        'string'
                            ? url
                            : String(url);

                    this._biliSmartRequestRange =
                        null;

                    return super.open(
                        method,
                        url,
                        ...rest
                    );
                }

                setRequestHeader(
                    name,
                    value
                ) {
                    if (
                        String(name)
                            .toLowerCase() ===
                        'range'
                    ) {
                        this._biliSmartRequestRange =
                            parseRangeHeader(
                                value
                            );
                    }

                    return super
                        .setRequestHeader(
                            name,
                            value
                        );
                }

                send(body) {
                    this.addEventListener(
                        'loadend',
                        () => {
                            try {
                                recordObservedMediaRange(
                                    this._biliSmartUrl,
                                    this._biliSmartRequestRange,
                                    this.status
                                );
                            } catch (error) {
                                warn(
                                    'range recording failed:',
                                    error
                                );
                            }
                        },
                        {
                            once: true,
                        }
                    );

                    return super.send(
                        body
                    );
                }

                get responseText() {
                    const originalText =
                        super.responseText;

                    if (
                        !shouldInterceptPlayUrl(
                            this._biliSmartUrl
                        )
                    ) {
                        return originalText;
                    }

                    try {
                        const json =
                            JSON.parse(
                                originalText
                            );

                        transformPlayInfo(
                            json
                        );

                        return JSON.stringify(
                            json
                        );
                    } catch {
                        return originalText;
                    }
                }

                get response() {
                    const originalResponse =
                        super.response;

                    if (
                        !shouldInterceptPlayUrl(
                            this._biliSmartUrl
                        )
                    ) {
                        return originalResponse;
                    }

                    if (
                        originalResponse &&
                        typeof originalResponse ===
                        'object'
                    ) {
                        try {
                            transformPlayInfo(
                                originalResponse
                            );
                        } catch (error) {
                            warn(
                                'XHR JSON transform failed:',
                                error
                            );
                        }

                        return originalResponse;
                    }

                    if (
                        typeof originalResponse ===
                        'string'
                    ) {
                        try {
                            const json =
                                JSON.parse(
                                    originalResponse
                                );

                            transformPlayInfo(
                                json
                            );

                            return JSON.stringify(
                                json
                            );
                        } catch {
                            return originalResponse;
                        }
                    }

                    return originalResponse;
                }
            };
    }

    function hookPlayInfo() {
        try {
            let internalPlayInfo =
                unsafeWindow.__playinfo__;

            Object.defineProperty(
                unsafeWindow,
                '__playinfo__',
                {
                    configurable: true,
                    enumerable: true,

                    get() {
                        return internalPlayInfo;
                    },

                    set(value) {
                        internalPlayInfo =
                            transformPlayInfo(
                                value
                            );
                    },
                }
            );

            if (internalPlayInfo) {
                internalPlayInfo =
                    transformPlayInfo(
                        internalPlayInfo
                    );
            }
        } catch (error) {
            warn(
                '__playinfo__ hook failed:',
                error
            );
        }
    }

    function getBufferedEnd(video) {
        if (!video?.buffered) {
            return Number(
                video?.currentTime ||
                0
            );
        }

        const currentTime =
            Number(
                video.currentTime ||
                0
            );

        for (
            let index = 0;
            index <
                video.buffered.length;
            index++
        ) {
            const start =
                video.buffered.start(
                    index
                );

            const end =
                video.buffered.end(
                    index
                );

            if (
                currentTime >=
                    start - 0.25 &&
                currentTime <=
                    end + 0.25
            ) {
                return end;
            }
        }

        return currentTime;
    }

    function getBufferAhead(video) {
        return Math.max(
            0,
            getBufferedEnd(video) -
                Number(
                    video?.currentTime ||
                    0
                )
        );
    }

    function formatTime(seconds) {
        if (
            !Number.isFinite(
                seconds
            )
        ) {
            return '--:--';
        }

        const value =
            Math.max(
                0,
                Math.floor(seconds)
            );

        const minutes =
            Math.floor(
                value / 60
            );

        const remainingSeconds =
            value % 60;

        return (
            String(minutes) +
            ':' +
            String(
                remainingSeconds
            ).padStart(
                2,
                '0'
            )
        );
    }

    function formatBytes(bytes) {
        if (
            !Number.isFinite(bytes) ||
            bytes <= 0
        ) {
            return '0.0 MiB';
        }

        return (
            bytes /
            1024 /
            1024
        ).toFixed(1) +
            ' MiB';
    }

    function createMonitorBox() {
        if (monitorBox) {
            return monitorBox;
        }

        monitorBox =
            document.createElement(
                'div'
            );

        monitorBox.id =
            'bili-smart-prefetch-monitor';

        Object.assign(
            monitorBox.style,
            {
                position:
                    'fixed',

                top:
                    '80px',

                right:
                    '20px',

                zIndex:
                    '2147483647',

                padding:
                    '10px 12px',

                borderRadius:
                    '8px',

                background:
                    'rgba(0, 0, 0, 0.82)',

                color:
                    '#ffffff',

                fontFamily:
                    'Consolas, monospace',

                fontSize:
                    '12px',

                lineHeight:
                    '1.55',

                pointerEvents:
                    'none',

                whiteSpace:
                    'pre',

                boxShadow:
                    '0 2px 12px rgba(0,0,0,.35)',
            }
        );

        monitorBox.textContent =
            'BiliSmart\nwaiting for video...';

        document
            .documentElement
            .appendChild(
                monitorBox
            );

        return monitorBox;
    }

    function updateMonitor() {
        if (!currentVideo) {
            return;
        }

        const box =
            createMonitorBox();

        const current =
            Number(
                currentVideo.currentTime ||
                0
            );

        const bufferedEnd =
            getBufferedEnd(
                currentVideo
            );

        const nativeBuffer =
            getBufferAhead(
                currentVideo
            );

        const duration =
            Number(
                currentVideo.duration ||
                0
            );

        const videoMedia =
            activeMedia.video;

        const audioMedia =
            activeMedia.audio;

        const videoState =
            videoMedia
                ? mediaStateByUrl.get(
                    videoMedia.url
                )
                : null;

        const audioState =
            audioMedia
                ? mediaStateByUrl.get(
                    audioMedia.url
                )
                : null;

        const videoBandwidth =
            videoMedia?.bandwidth ||
            0;

        const audioBandwidth =
            audioMedia?.bandwidth ||
            0;

        const videoReserveBytes =
            getReserveBytes(
                videoState
            );

        const audioReserveBytes =
            getReserveBytes(
                audioState
            );

        const videoReserveSeconds =
            reserveSeconds(
                videoState,
                videoBandwidth
            );

        const audioReserveSeconds =
            reserveSeconds(
                audioState,
                audioBandwidth
            );

        box.textContent = [
            `BiliSmart v${VERSION}`,

            `State: ${
                currentVideo.paused
                    ? 'PAUSED'
                    : 'PLAYING'
            }`,

            `Current: ${formatTime(
                current
            )}`,

            `Buffered to: ${formatTime(
                bufferedEnd
            )}`,

            `Native buffer: ${nativeBuffer.toFixed(
                1
            )} s`,

            '',

            `Video host: ${
                videoMedia
                    ? getHost(
                        videoMedia.url
                    )
                    : 'waiting'
            }`,

            `Video bw: ${
                videoBandwidth
                    ? (
                        videoBandwidth /
                        1_000_000
                    ).toFixed(2) +
                    ' Mbps'
                    : '--'
            }`,

            `Video reserve: ${formatBytes(
                videoReserveBytes
            )}`,

            `Reserve estimate: ${videoReserveSeconds.toFixed(
                1
            )} s`,

            `Reserve target: ${TARGET_VIDEO_RESERVE_SECONDS} s`,

            '',

            `Audio reserve: ${formatBytes(
                audioReserveBytes
            )}`,

            `Audio estimate: ${audioReserveSeconds.toFixed(
                1
            )} s`,

            '',

            `Batch video: ${formatBytes(
                currentBatchVideoBytes
            )}`,

            `Batch audio: ${formatBytes(
                currentBatchAudioBytes
            )}`,

            `Prefetch: ${lastPrefetchMessage}`,

            `Running: ${
                prefetchRunning
                    ? 'YES'
                    : 'NO'
            }`,

            '',

            `Seek baseline: ${
                pendingSeekBaseline.video ||
                pendingSeekBaseline.audio
                    ? 'WAITING'
                    : 'READY'
            }`,

            `ReadyState: ${
                currentVideo.readyState
            }`,

            `NetworkState: ${
                currentVideo.networkState
            }`,

            `Duration: ${formatTime(
                duration
            )}`,

            `Audio: ${
                audioMedia
                    ? 'detected'
                    : 'waiting'
            }`,
        ].join('\n');
    }

    function cancelPrefetch(
        reason = 'Cancelled'
    ) {
        pauseSessionId++;

        if (
            prefetchAbortController
        ) {
            prefetchAbortController
                .abort();

            prefetchAbortController =
                null;
        }

        prefetchRunning =
            false;

        lastPrefetchMessage =
            reason;
    }

    async function fetchRange(
        url,
        start,
        end,
        signal
    ) {
        const requestController =
            new AbortController();

        let timedOut = false;

        const handleExternalAbort = () => {
            requestController.abort();
        };

        if (signal?.aborted) {
            requestController.abort();
        } else if (signal) {
            signal.addEventListener(
                'abort',
                handleExternalAbort,
                {
                    once: true,
                }
            );
        }

        const timeoutId =
            setTimeout(
                () => {
                    timedOut = true;
                    requestController.abort();
                },
                RANGE_REQUEST_TIMEOUT_MS
            );

        try {
            const response =
                await originalFetch.call(
                    unsafeWindow,
                    url,
                    {
                        method:
                            'GET',

                        headers: {
                            Range:
                                `bytes=${start}-${end}`,
                        },

                        mode:
                            'cors',

                        credentials:
                            'omit',

                        cache:
                            'default',

                        referrer:
                            location.href,

                        signal:
                            requestController.signal,
                    }
                );

            if (
                response.status ===
                416
            ) {
                const rawContentRange =
                    response.headers.get(
                        'content-range'
                    );

                const unsatisfied =
                    parseUnsatisfiedContentRange(
                        rawContentRange
                    );

                return {
                    bytes: 0,
                    contentRange: null,

                    total:
                        unsatisfied?.total ??
                        null,

                    status: 416,
                };
            }

            if (
                response.status !==
                    206 &&
                response.status !==
                    200
            ) {
                throw new Error(
                    `Unexpected status ${response.status}`
                );
            }

            const contentRange =
                parseContentRange(
                    response.headers.get(
                        'content-range'
                    )
                );

            const data =
                await response
                    .arrayBuffer();

            return {
                bytes:
                    data.byteLength,

                contentRange,

                total:
                    contentRange?.total ??
                    null,

                status:
                    response.status,
            };
        } catch (error) {
            if (
                timedOut &&
                !signal?.aborted
            ) {
                const timeoutError =
                    new Error(
                        `Range request timed out after ${RANGE_REQUEST_TIMEOUT_MS} ms`
                    );

                timeoutError.name =
                    'TimeoutError';

                throw timeoutError;
            }

            throw error;
        } finally {
            clearTimeout(
                timeoutId
            );

            if (signal) {
                signal.removeEventListener(
                    'abort',
                    handleExternalAbort
                );
            }
        }
    }

    async function fetchRangeWithRetry({
        type,
        url,
        start,
        end,
        signal,
    }) {
        for (
            let attempt = 0;
            attempt <=
                RANGE_REQUEST_MAX_RETRIES;
            attempt++
        ) {
            try {
                return await fetchRange(
                    url,
                    start,
                    end,
                    signal
                );
            } catch (error) {
                if (
                    signal?.aborted ||
                    error?.name ===
                        'AbortError'
                ) {
                    throw error;
                }

                if (
                    attempt <
                    RANGE_REQUEST_MAX_RETRIES
                ) {
                    warn(
                        `${type} Range request retry:`,
                        {
                            start,
                            end,
                            attempt:
                                attempt + 1,
                            error:
                                error?.message ||
                                String(error),
                        }
                    );

                    continue;
                }

                warn(
                    `${type} Range failed after retries:`,
                    {
                        start,
                        end,
                        attempts:
                            attempt + 1,
                        error:
                            error?.message ||
                            String(error),
                    }
                );

                return null;
            }
        }

        return null;
    }

    function calculateRecoveryStart(
        total
    ) {
        if (
            !Number.isFinite(total) ||
            total <= 0
        ) {
            return null;
        }

        const duration =
            Number(
                currentVideo?.duration ||
                0
            );

        const mediaTime =
            getBufferedEnd(
                currentVideo
            );

        if (
            !Number.isFinite(duration) ||
            duration <= 0
        ) {
            return 0;
        }

        const ratio =
            clamp(
                mediaTime /
                duration,
                0,
                0.995
            );

        return Math.min(
            total - 1,

            Math.max(
                0,
                Math.floor(
                    total *
                    ratio
                )
            )
        );
    }

    async function prefetchMedia({
        type,
        media,
        chunkBytes,
        bytesToFetch,
        signal,
        sessionId,
    }) {
        if (
            !media?.url ||
            bytesToFetch <= 0
        ) {
            return {
                bytes: 0,
                completed: true,
                failureReason: null,
            };
        }

        const state =
            updateMediaCursor(
                media.url
            );

        let start =
            state.nextStart;

        let completedBytes =
            0;

        let recoveryAttempts =
            0;

        let completed = true;
        let failureReason = null;

        log(
            `${type} adaptive top-up started:`,
            {
                host:
                    getHost(
                        media.url
                    ),

                bandwidth:
                    media.bandwidth,

                start,

                bytesToFetch,

                reserveBytes:
                    getReserveBytes(
                        state
                    ),

                total:
                    state.total,
            }
        );

        while (
            completedBytes <
            bytesToFetch
        ) {
            if (
                signal.aborted ||
                sessionId !==
                    pauseSessionId ||
                !currentVideo?.paused
            ) {
                break;
            }

            if (
                Number.isFinite(
                    state.total
                ) &&
                start >=
                    state.total
            ) {
                lastPrefetchMessage =
                    `${type}: file end`;

                break;
            }

            const remainingBytes =
                bytesToFetch -
                completedBytes;

            const requestedSize =
                Math.min(
                    chunkBytes,
                    remainingBytes
                );

            let end =
                start +
                requestedSize -
                1;

            if (
                Number.isFinite(
                    state.total
                )
            ) {
                end =
                    Math.min(
                        end,
                        state.total - 1
                    );
            }

            if (
                end < start
            ) {
                lastPrefetchMessage =
                    `${type}: file end`;

                break;
            }

            lastPrefetchMessage =
                `${type}: ${formatBytes(
                    completedBytes
                )}/${formatBytes(
                    bytesToFetch
                )}`;

            const result =
                await fetchRangeWithRetry({
                    type,
                    url:
                        media.url,
                    start,
                    end,
                    signal,
                });

            if (!result) {
                completed = false;
                failureReason =
                    'request failed';

                lastPrefetchMessage =
                    `${type}: request failed`;

                break;
            }

            if (
                result.status ===
                416
            ) {
                if (
                    Number.isFinite(
                        result.total
                    ) &&
                    recoveryAttempts <
                        1
                ) {
                    recoveryAttempts++;

                    state.total =
                        result.total;

                    const recoveryStart =
                        calculateRecoveryStart(
                            result.total
                        );

                    if (
                        Number.isFinite(
                            recoveryStart
                        )
                    ) {
                        state.observedEnd =
                            Math.min(
                                state.observedEnd,
                                recoveryStart - 1
                            );

                        state.prefetchedEnd =
                            Math.min(
                                state.prefetchedEnd,
                                recoveryStart - 1
                            );

                        state.nextStart =
                            recoveryStart;

                        start =
                            recoveryStart;

                        log(
                            'Range 416 recovered:',
                            {
                                type,
                                total:
                                    result.total,
                                recoveryStart,
                            }
                        );

                        continue;
                    }
                }

                lastPrefetchMessage =
                    `${type}: outside file`;

                break;
            }

            recoveryAttempts =
                0;

            if (
                result.contentRange
            ) {
                if (
                    Number.isFinite(
                        result
                            .contentRange
                            .total
                    )
                ) {
                    state.total =
                        result
                            .contentRange
                            .total;
                }

                state.prefetchedEnd =
                    Math.max(
                        state.prefetchedEnd,
                        result
                            .contentRange
                            .end
                    );
            } else {
                state.prefetchedEnd =
                    Math.max(
                        state.prefetchedEnd,
                        start +
                            result.bytes -
                            1
                    );
            }

            completedBytes +=
                result.bytes;

            state.nextStart =
                Math.max(
                    state.nextStart,
                    state.prefetchedEnd + 1,
                    state.observedEnd + 1
                );

            if (
                Number.isFinite(
                    state.total
                )
            ) {
                state.nextStart =
                    Math.min(
                        state.nextStart,
                        state.total
                    );
            }

            start =
                state.nextStart;

            log(
                `${type} adaptive top-up complete:`,
                {
                    bytes:
                        result.bytes,

                    completedBytes,

                    targetBytes:
                        bytesToFetch,

                    reserveBytes:
                        getReserveBytes(
                            state
                        ),

                    nextStart:
                        state.nextStart,
                }
            );
        }

        return {
            bytes:
                completedBytes,

            completed,
            failureReason,
        };
    }

    async function startPausedPrefetch(
        sessionId
    ) {
        if (
            prefetchRunning ||
            !currentVideo ||
            !currentVideo.paused ||
            sessionId !==
                pauseSessionId
        ) {
            return;
        }

        /*
         * seek 后还没获得新 Range 基准时，
         * 暂时不预取，避免从旧位置继续下载。
         */
        if (
            pendingSeekBaseline.video
        ) {
            lastPrefetchMessage =
                'Waiting for seek baseline';

            return;
        }

        const now =
            Date.now();

        if (
            now -
                lastPrefetchAt <
            PREFETCH_COOLDOWN_MS
        ) {
            lastPrefetchMessage =
                'Cooldown';

            return;
        }

        const videoMedia =
            activeMedia.video;

        if (
            !videoMedia?.url
        ) {
            lastPrefetchMessage =
                'Waiting for video Range';

            return;
        }

        const videoState =
            updateMediaCursor(
                videoMedia.url
            );

        const videoPlan =
            calculateTopUpPlan({
                state:
                    videoState,

                bandwidth:
                    videoMedia.bandwidth,

                targetSeconds:
                    TARGET_VIDEO_RESERVE_SECONDS,

                maxReserveBytes:
                    MAX_VIDEO_RESERVE_BYTES,

                maxTopUpBytes:
                    MAX_VIDEO_TOPUP_PER_PAUSE,

                minTopUpBytes:
                    MIN_VIDEO_TOPUP_BYTES,

                chunkBytes:
                    VIDEO_CHUNK_BYTES,
            });

        let audioPlan = {
            reserveBytes: 0,
            targetBytes: 0,
            topUpBytes: 0,
        };

        if (
            activeMedia.audio?.url &&
            !pendingSeekBaseline.audio
        ) {
            const audioState =
                updateMediaCursor(
                    activeMedia.audio.url
                );

            audioPlan =
                calculateTopUpPlan({
                    state:
                        audioState,

                    bandwidth:
                        activeMedia.audio
                            .bandwidth,

                    targetSeconds:
                        TARGET_AUDIO_RESERVE_SECONDS,

                    maxReserveBytes:
                        MAX_AUDIO_RESERVE_BYTES,

                    maxTopUpBytes:
                        MAX_AUDIO_TOPUP_PER_PAUSE,

                    minTopUpBytes:
                        MIN_AUDIO_TOPUP_BYTES,

                    chunkBytes:
                        AUDIO_CHUNK_BYTES,
                });
        }

        if (
            videoPlan.topUpBytes <= 0 &&
            audioPlan.topUpBytes <= 0
        ) {
            lastPrefetchMessage =
                `Reserve sufficient: ${reserveSeconds(
                    videoState,
                    videoMedia.bandwidth
                ).toFixed(0)}s`;

            log(
                'adaptive prefetch skipped:',
                {
                    videoReserve:
                        videoPlan.reserveBytes,

                    videoTarget:
                        videoPlan.targetBytes,

                    audioReserve:
                        audioPlan.reserveBytes,

                    audioTarget:
                        audioPlan.targetBytes,
                }
            );

            return;
        }

        prefetchRunning =
            true;

        lastPrefetchAt =
            now;

        currentBatchVideoBytes =
            0;

        currentBatchAudioBytes =
            0;

        prefetchAbortController =
            new AbortController();

        const signal =
            prefetchAbortController
                .signal;

        lastPrefetchMessage =
            'Calculating top-up';

        log(
            'adaptive prefetch batch:',
            {
                videoReserveBytes:
                    videoPlan.reserveBytes,

                videoTargetBytes:
                    videoPlan.targetBytes,

                videoTopUpBytes:
                    videoPlan.topUpBytes,

                audioReserveBytes:
                    audioPlan.reserveBytes,

                audioTargetBytes:
                    audioPlan.targetBytes,

                audioTopUpBytes:
                    audioPlan.topUpBytes,
            }
        );

        let videoResult = {
            bytes: 0,
            completed: true,
            failureReason: null,
        };

        let audioResult = {
            bytes: 0,
            completed: true,
            failureReason: null,
        };

        try {
            videoResult =
                await prefetchMedia({
                    type:
                        'video',

                    media:
                        videoMedia,

                    chunkBytes:
                        VIDEO_CHUNK_BYTES,

                    bytesToFetch:
                        videoPlan.topUpBytes,

                    signal,

                    sessionId,
                });

            currentBatchVideoBytes =
                videoResult.bytes;

            if (
                !signal.aborted &&
                sessionId ===
                    pauseSessionId &&
                currentVideo.paused &&
                activeMedia.audio?.url &&
                !pendingSeekBaseline.audio &&
                audioPlan.topUpBytes > 0
            ) {
                audioResult =
                    await prefetchMedia({
                        type:
                            'audio',

                        media:
                            activeMedia.audio,

                        chunkBytes:
                            AUDIO_CHUNK_BYTES,

                        bytesToFetch:
                            audioPlan.topUpBytes,

                        signal,

                        sessionId,
                    });

                currentBatchAudioBytes =
                    audioResult.bytes;
            }

            if (
                !signal.aborted
            ) {
                const updatedVideoState =
                    mediaStateByUrl.get(
                        videoMedia.url
                    );

                const updatedReserveSeconds =
                    reserveSeconds(
                        updatedVideoState,
                        videoMedia.bandwidth
                    );

                const batchCompleted =
                    videoResult.completed &&
                    audioResult.completed;

                if (batchCompleted) {
                    lastPrefetchMessage =
                        currentBatchVideoBytes > 0
                            ? `Topped up ${formatBytes(
                                currentBatchVideoBytes
                            )}, reserve ~${updatedReserveSeconds.toFixed(
                                0
                            )}s`
                            : `Reserve ~${updatedReserveSeconds.toFixed(
                                0
                            )}s`;

                    log(
                        'adaptive prefetch batch complete:',
                        {
                            videoBytes:
                                currentBatchVideoBytes,

                            audioBytes:
                                currentBatchAudioBytes,

                            videoReserveSeconds:
                                updatedReserveSeconds,
                        }
                    );
                } else {
                    const failedParts = [];

                    if (!videoResult.completed) {
                        failedParts.push('video');
                    }

                    if (!audioResult.completed) {
                        failedParts.push('audio');
                    }

                    lastPrefetchMessage =
                        `Partial failure: ${failedParts.join(
                            ', '
                        )}`;

                    warn(
                        'adaptive prefetch batch ended with partial failure:',
                        {
                            videoBytes:
                                currentBatchVideoBytes,

                            audioBytes:
                                currentBatchAudioBytes,

                            videoReserveSeconds:
                                updatedReserveSeconds,

                            videoCompleted:
                                videoResult.completed,

                            videoFailureReason:
                                videoResult.failureReason,

                            audioCompleted:
                                audioResult.completed,

                            audioFailureReason:
                                audioResult.failureReason,
                        }
                    );
                }
            }
        } catch (error) {
            if (
                error?.name ===
                'AbortError'
            ) {
                lastPrefetchMessage =
                    'Stopped on playback';
            } else {
                lastPrefetchMessage =
                    `Failed: ${error.message}`;

                warn(
                    'adaptive prefetch failed:',
                    error
                );
            }
        } finally {
            prefetchRunning =
                false;

            prefetchAbortController =
                null;
        }
    }

    function handlePause() {
        const sessionId =
            ++pauseSessionId;

        setTimeout(
            () => {
                if (
                    currentVideo?.paused &&
                    sessionId ===
                        pauseSessionId
                ) {
                    startPausedPrefetch(
                        sessionId
                    );
                }
            },
            PAUSE_PREFETCH_DELAY_MS
        );
    }

    function handlePlay() {
        cancelPrefetch(
            'Playback resumed'
        );
    }

    function handleSeeking() {
        cancelPrefetch(
            'Seeking'
        );

        pendingSeekBaseline.video =
            true;

        pendingSeekBaseline.audio =
            true;

        seekGraceUntil =
            Date.now() +
            SEEK_GRACE_MS;

        currentBatchVideoBytes =
            0;

        currentBatchAudioBytes =
            0;

        lastPrefetchMessage =
            'Waiting for seek baseline';

        log(
            'seek detected: waiting for new media baseline'
        );
    }

    function handleSeeked() {
        seekGraceUntil =
            Math.max(
                seekGraceUntil,
                Date.now() +
                4_000
            );

        log(
            'seek completed: grace period extended'
        );
    }

    function attachVideo(video) {
        if (
            !video ||
            video === currentVideo
        ) {
            return;
        }

        if (currentVideo) {
            currentVideo
                .removeEventListener(
                    'pause',
                    handlePause
                );

            currentVideo
                .removeEventListener(
                    'play',
                    handlePlay
                );

            currentVideo
                .removeEventListener(
                    'seeking',
                    handleSeeking
                );

            currentVideo
                .removeEventListener(
                    'seeked',
                    handleSeeked
                );

            currentVideo
                .removeEventListener(
                    'ended',
                    handlePlay
                );
        }

        cancelPrefetch(
            'Video changed'
        );

        currentVideo =
            video;

        currentBatchVideoBytes =
            0;

        currentBatchAudioBytes =
            0;

        pendingSeekBaseline.video =
            false;

        pendingSeekBaseline.audio =
            false;

        seekGraceUntil =
            0;

        lastPrefetchMessage =
            'Idle';

        currentVideo
            .addEventListener(
                'pause',
                handlePause
            );

        currentVideo
            .addEventListener(
                'play',
                handlePlay
            );

        currentVideo
            .addEventListener(
                'seeking',
                handleSeeking
            );

        currentVideo
            .addEventListener(
                'seeked',
                handleSeeked
            );

        currentVideo
            .addEventListener(
                'ended',
                handlePlay
            );

        log(
            'video element attached'
        );
    }

    function findVideoElement() {
        const videos =
            Array.from(
                document
                    .querySelectorAll(
                        'video'
                    )
            );

        if (!videos.length) {
            return;
        }

        const largestVideo =
            videos
                .map(
                    video => {
                        const rect =
                            video
                                .getBoundingClientRect();

                        return {
                            video,

                            area:
                                rect.width *
                                rect.height,
                        };
                    }
                )
                .sort(
                    (
                        a,
                        b
                    ) =>
                        b.area -
                        a.area
                )[0]
                ?.video;

        if (largestVideo) {
            attachVideo(
                largestVideo
            );
        }
    }

    function startMonitor() {
    if (monitorTimer) {
        clearInterval(
            monitorTimer
        );
    }

    monitorTimer =
        setInterval(
            () => {
                findVideoElement();

                if (DEBUG_MONITOR) {
                    updateMonitor();
                }
            },
            MONITOR_INTERVAL_MS
        );
    }

    hookPlayInfo();

    if (
        document.readyState ===
        'loading'
    ) {
        document.addEventListener(
            'DOMContentLoaded',
            startMonitor,
            {
                once: true,
            }
        );
    } else {
        startMonitor();
    }

    log(
        `loaded v${VERSION}`
    );
})();
