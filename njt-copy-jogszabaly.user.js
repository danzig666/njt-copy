// ==UserScript==
// @name         NJT Copy jogszabály to Word
// @namespace    https://github.com/example/njt-copy
// @version      1.0.2
// @description  NJT-jogszabályok másolása Wordbe illeszthető formázással és egyszerű szövegként.
// @homepageURL  https://github.com/danzig666/njt-copy
// @downloadURL  https://raw.githubusercontent.com/danzig666/njt-copy/main/njt-copy-jogszabaly.user.js
// @updateURL    https://raw.githubusercontent.com/danzig666/njt-copy/main/njt-copy-jogszabaly.user.js
// @author       Generated
// @match        https://njt.jog.gov.hu/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

// Run on the whole site: Angular navigation from search to a legal document
// does not reload the page, so the script must already be running on search.
// initialize() and the DOM observer restrict the button to /jogszabaly/ pages.

// Phase 1 (document-start): block the site from hijacking context menu
// and text selection.  MUST run before the page's own scripts.
(function () {
    'use strict';

    try {
        var origAEL = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = function (type, listener, options) {
            if (type === 'contextmenu' || type === 'selectstart' || type === 'dragstart' ||
                type === 'selectionchange' || type === 'copy' || type === 'cut' ||
                type === 'mouseup' || type === 'mousedown') {
                return;
            }
            return origAEL.call(this, type, listener, options);
        };
    } catch (e) {}

    try {
        var selBlockList = ['removeAllRanges', 'collapse', 'empty', 'deleteFromDocument',
            'setBaseAndExtent', 'extend', 'modify', 'selectAllChildren',
            'setPosition', 'addRange'];
        selBlockList.forEach(function (m) {
            if (Selection.prototype[m]) {
                Selection.prototype[m] = function () { /* blocked */ };
            }
        });

        // Also block Range mutation methods — the site wraps selection
        // in <span class="highlighted"> via surroundContents / insertNode
        var rangeBlockList = ['surroundContents', 'insertNode',
            'extractContents', 'deleteContents'];
        rangeBlockList.forEach(function (m) {
            if (Range.prototype[m]) {
                Range.prototype[m] = function () { /* blocked */ };
            }
        });
    } catch (e) {}

    try {
        var blockedProps = ['onselectstart', 'oncontextmenu', 'ondragstart', 'oncopy', 'oncut',
            'onmouseup', 'onmousedown'];
        blockedProps.forEach(function (prop) {
            [Document.prototype, HTMLElement.prototype].forEach(function (proto) {
                var desc = Object.getOwnPropertyDescriptor(proto, prop);
                if (desc && desc.configurable) {
                    try {
                        Object.defineProperty(proto, prop, {
                            get: function () { return null; },
                            set: function () { /* blocked */ },
                            configurable: false
                        });
                    } catch (e) {}
                }
            });
        });
    } catch (e) {}

    // Defer style injection until <html> exists
    function injectStyle() {
        try {
            var s = document.createElement('style');
            s.textContent = 'body,.jogszabaly,#jogszab,#jogszab *{-webkit-user-select:text!important;user-select:text!important}' +
                '#bottom_flag_line{visibility:hidden!important}';
            (document.head || document.documentElement || document.body).appendChild(s);
        } catch (e) {}
    }
    if (document.documentElement) {
        injectStyle();
    } else {
        document.addEventListener('DOMContentLoaded', injectStyle);
    }
})();

// Phase 2 (DOM ready): main script initializes when body is available
(function () {
    'use strict';

    // -----------------------------------------------------------------------
    // Configuration
    // -----------------------------------------------------------------------

    /** Selector for the main legal-text content container (tried in order) */
    var CONTENT_SELECTORS = [
        '#jogszab',                          // primary container per page source
        '.jogszabaly',                       // legacy / generic fallback
        '[data-ng-non-bindable="true"]',     // server-rendered block
    ];

    /** Elements / selectors to REMOVE from the clone (chrome, UI, markers) */
    var REMOVE_SELECTORS = [
        '.changeVersionParent',              // date-picker button inside content
        '.jumpButtonsContainer',             // jump-to-changed-slice buttons
        '.jhId',                             // internal anchor marker spans
        '.accessiblehidden',                 // screen-reader-only helpers
        '#sidemenu-window-left',             // TOC sidebar (shouldn't be inside, but safety)
        '.sidemenu-window',                  // any side-menu panel
        '#operationMenu',                    // action bar (search, print, etc.)
        '.action-menu-wrapper',              // action bar wrapper
        'script',                            // all scripts
        'style',                             // inline styles (we add our own)
        'noscript',
        'button',                            // interactive buttons
        'input',
        'select',
        'textarea',
        '.fnRef',                            // footnote reference popup/container
        '.fnPopup',                          // footnote popup
        '.tooltip',
        '.njt-tooltip',
        '[role="tooltip"]',
        '.beta-tag',
        '.growl',
        '.modal',
        '.overlay',
        '.footnote',                         // footnote containers at end of document
        'a.resource_link',                   // PDF attachment links (remove entirely)
        'a.resource',                        // PDF attachment links (remove entirely)
    ];

    /** Footnote superscript selectors to remove */
    var FN_SUP_SELECTORS = [
        'sup.fnSup',
        'sup[data-note-id]',
    ];

    /** Scroll step in pixels when traversing the page for lazy-loaded content */
    var SCROLL_STEP_PX = 2000;

    /** Wait between scroll steps (ms) */
    var SCROLL_WAIT_MS = 50;

    /** Maximum number of consecutive no-change checks before stopping scroll */
    var MAX_NO_CHANGE_CHECKS = 8;

    /** Maximum total scroll attempts (safety limit) */
    var MAX_SCROLL_ATTEMPTS = 200;

    /** Base URL for resolving relative links (inferred from <base> tag or location) */
    var BASE_URL = (function () {
        var b = document.querySelector('base[href]');
        if (b) {
            // ensure absolute
            var u = b.getAttribute('href');
            if (u) return new URL(u, location.origin).href.replace(/\/$/, '');
        }
        return location.origin;
    })();

    // -----------------------------------------------------------------------
    // Utility helpers
    // -----------------------------------------------------------------------

    /** Resolve a potentially relative URL to absolute, using BASE_URL */
    function toAbsoluteUrl(url) {
        if (!url) return url;
        try {
            return new URL(url, BASE_URL).href;
        } catch (e) {
            return url;
        }
    }

    /** Find the main content element using heuristics */
    function findContentElement() {
        for (var i = 0; i < CONTENT_SELECTORS.length; i++) {
            var el = document.querySelector(CONTENT_SELECTORS[i]);
            if (el) return el;
        }

        // Heuristic fallback: find the largest text-heavy element inside <main>
        var main = document.querySelector('main');
        if (!main) main = document.body;

        var candidates = main.querySelectorAll('div, article, section');
        var best = null;
        var bestText = 0;
        for (var j = 0; j < candidates.length; j++) {
            var t = candidates[j].textContent.replace(/\s+/g, ' ').trim().length;
            // Skip tiny containers and obvious chrome
            if (t > 500 && t > bestText) {
                // Avoid action-menu, header, footer, nav, sidebar areas
                var id = candidates[j].id || '';
                var cls = candidates[j].className || '';
                var combined = id + ' ' + cls;
                if (/menu|header|footer|nav|sidebar|toolbar|action|cookie/i.test(combined)) continue;
                best = candidates[j];
                bestText = t;
            }
        }
        return best;
    }

    /** Get the main scroll container (element with overflow, or window) */
    function getScrollContainer() {
        // Check common scrollable containers
        var candidates = [
            document.querySelector('.jogszabaly-wrapper'),
            document.querySelector('.mainContent'),
            document.querySelector('.content.wrapper'),
            document.querySelector('#main'),
            document.querySelector('#jogszabaly-reader'),
            document.querySelector('.mainWrapper'),
        ];
        for (var i = 0; i < candidates.length; i++) {
            var el = candidates[i];
            if (!el) continue;
            var s = window.getComputedStyle(el);
            if (s.overflowY === 'auto' || s.overflowY === 'scroll' || s.overflow === 'auto' || s.overflow === 'scroll') {
                if (el.scrollHeight > el.clientHeight + 10) return el;
            }
        }
        return null; // signals window scrolling
    }

    // -----------------------------------------------------------------------
    // Lazy-load forcing: scroll through the entire page so virtual/dynamic
    // content gets rendered before we clone.
    // -----------------------------------------------------------------------

    /** Returns total scrollable height (clientHeight for container, documentHeight for window) */
    function getTotalHeight(container) {
        if (container) return container.scrollHeight;
        return Math.max(
            document.documentElement.scrollHeight,
            document.body.scrollHeight,
            document.documentElement.offsetHeight,
            document.body.offsetHeight
        );
    }

    /** Returns current scroll position */
    function getScrollPos(container) {
        if (container) return container.scrollTop;
        return window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
    }

    /** Sets scroll position */
    function setScrollPos(container, pos) {
        if (container) {
            container.scrollTop = pos;
        } else {
            window.scrollTo(0, pos);
        }
    }

    /**
     * Scroll through the full content slowly to trigger lazy-loading.
     * Returns a Promise that resolves when done.
     */
    function ensureAllContentLoaded(container) {
        return new Promise(function (resolve) {
            var origPos = getScrollPos(container);
            var totalHeight = getTotalHeight(container);
            var currentPos = 0;
            var noChangeCount = 0;
            var lastHeight = totalHeight;
            var attempts = 0;

            function step() {
                attempts++;
                if (attempts > MAX_SCROLL_ATTEMPTS) {
                    // Safety: stop trying
                    finalize();
                    return;
                }

                // Scroll down one step
                currentPos += SCROLL_STEP_PX;
                setScrollPos(container, currentPos);

                // After a brief wait, check if content grew
                setTimeout(function () {
                    var newHeight = getTotalHeight(container);

                    if (newHeight > lastHeight) {
                        // Content expanded - reset no-change counter,
                        // extend our target, and keep going
                        noChangeCount = 0;
                        lastHeight = newHeight;
                        totalHeight = newHeight;
                    } else if (currentPos >= totalHeight - (container ? container.clientHeight : window.innerHeight)) {
                        // We've scrolled to/past the bottom
                        noChangeCount++;
                    } else {
                        // Still scrolling through known content
                        noChangeCount = 0;
                    }

                    if (noChangeCount >= MAX_NO_CHANGE_CHECKS) {
                        // No new content for several checks after reaching bottom
                        finalize();
                    } else if (currentPos >= totalHeight && noChangeCount > 0) {
                        // At/past the end, keep checking for a bit
                        setTimeout(step, SCROLL_WAIT_MS);
                    } else {
                        step();
                    }
                }, SCROLL_WAIT_MS);
            }

            function finalize() {
                // Restore original position
                setScrollPos(container, origPos);
                resolve();
            }

            // Start at top
            setScrollPos(container, 0);
            step();
        });
    }

    // -----------------------------------------------------------------------
    // MutationObserver-based content-change detection (secondary approach)
    // -----------------------------------------------------------------------

    /**
     * Returns a Promise that resolves after `ms` milliseconds of DOM stability
     * (no mutations observed) or after a hard timeout.
     */
    function waitForDomStability(targetEl, stableMs, hardTimeoutMs) {
        return new Promise(function (resolve) {
            var timer = null;
            var hardTimer = null;
            var observer = null;

            function done() {
                if (observer) observer.disconnect();
                if (timer) clearTimeout(timer);
                if (hardTimer) clearTimeout(hardTimer);
                resolve();
            }

            function resetStableTimer() {
                if (timer) clearTimeout(timer);
                timer = setTimeout(done, stableMs);
            }

            hardTimer = setTimeout(done, hardTimeoutMs);

            try {
                observer = new MutationObserver(function () {
                    resetStableTimer();
                });
                observer.observe(targetEl || document.body, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    attributeFilter: ['style', 'class', 'data-src', 'src'],
                });
            } catch (e) {
                // Fallback: just wait
                setTimeout(done, hardTimeoutMs);
                return;
            }

            resetStableTimer();
        });
    }

    // -----------------------------------------------------------------------
    // Content cleaning – clone the content and strip unwanted elements
    // -----------------------------------------------------------------------

    /**
     * Clone the given element and clean it for Word paste.
     * Returns a DocumentFragment-like clone (actually a deep-cloned element).
     */
    function cleanContent(sourceEl) {
        var clone = sourceEl.cloneNode(true);

        // 1. FULL NORMALIZATION for Word compatibility — MUST run first
        //    while clone and original trees are structurally identical so
        //    the parallel TreeWalker stays in sync.
        normalizeForWord(clone);

        // 2. Remove footnote superscripts
        for (var f = 0; f < FN_SUP_SELECTORS.length; f++) {
            var sups = clone.querySelectorAll(FN_SUP_SELECTORS[f]);
            for (var s = 0; s < sups.length; s++) {
                sups[s].parentNode.removeChild(sups[s]);
            }
        }

        // 3. Remove interactive / chrome UI elements
        for (var r = 0; r < REMOVE_SELECTORS.length; r++) {
            var els = clone.querySelectorAll(REMOVE_SELECTORS[r]);
            for (var e = 0; e < els.length; e++) {
                var el = els[e];
                if (el.parentNode) el.parentNode.removeChild(el);
            }
        }

        // 4. Strip event handlers, onclick, onsubmit etc.
        var allEls = clone.querySelectorAll('*');
        for (var a = 0; a < allEls.length; a++) {
            var el = allEls[a];
            var attrsToRemove = [];
            for (var at = 0; at < el.attributes.length; at++) {
                var name = el.attributes[at].name;
                if (/^on[a-z]+$/i.test(name) ||
                    name === 'data-ng-click' ||
                    name === 'data-ng-controller' ||
                    name === 'data-ng-init' ||
                    name === 'data-ng-model' ||
                    name === 'data-ng-disabled' ||
                    name === 'data-ng-blur' ||
                    name === 'data-ng-focus' ||
                    name === 'data-njtinput' ||
                    name === 'data-enterkeypress' ||
                    name === 'data-njttip' ||
                    name === 'data-njttitle' ||
                    name === 'data-njttipposition' ||
                    name === 'tabindex' ||
                    name === 'aria-expanded' ||
                    name === 'aria-controls' ||
                    name === 'role' ||
                    (name === 'class' && /\baccessiblehidden\b/i.test(el.attributes[at].value))
                ) {
                    attrsToRemove.push(name);
                }
            }
            for (var ar = 0; ar < attrsToRemove.length; ar++) {
                el.removeAttribute(attrsToRemove[ar]);
            }
            if (el.getAttribute('style') === '') {
                el.removeAttribute('style');
            }
        }

        // 5. Remove all <a> link elements — unwrap them to keep the text
        //    and its formatting (bold, italic, etc.) but drop the hyperlink.
        var links = clone.querySelectorAll('a');
        for (var l = links.length - 1; l >= 0; l--) {
            var link = links[l];
            if (!link.parentNode) continue;
            while (link.firstChild) {
                link.parentNode.insertBefore(link.firstChild, link);
            }
            link.parentNode.removeChild(link);
        }

        // 6. Resolve image sources to absolute URLs
        var imgs = clone.querySelectorAll('img');
        for (var im = 0; im < imgs.length; im++) {
            var img = imgs[im];
            var src = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('src') || '';
            if (src) {
                img.setAttribute('src', toAbsoluteUrl(src));
            }
            var srcset = img.getAttribute('data-srcset') || img.getAttribute('srcset');
            if (srcset) {
                img.setAttribute('srcset', srcset.replace(/(https?:\/\/[^\s,]+|[^\s,]+)(\s+\d+[wx])?/g, function (match, url, size) {
                    return toAbsoluteUrl(url) + (size || '');
                }));
            }
            img.removeAttribute('data-src');
            img.removeAttribute('data-lazy-src');
            img.removeAttribute('data-srcset');
            img.removeAttribute('loading');
        }

        // 7. Clean up empty containers left after removals
        cleanEmptyElements(clone);

        // 8. Diagnostic: log aligned elements for verification
        logAlignmentDiagnostics(clone);

        return clone;
    }

    /**
     * Post-processing for Word compatibility.
     *
     * Word's HTML import respects inline text-align on <p> elements ONLY
     * when the HTML is recognized as "Word-native" (has MsoNormal class +
     * @page directive).  We add class=MsoNormal to all <p> elements and
     * set inline text-align for center/right alignment.
     */
    function normalizeForWord(clone) {
        var original = findContentElement();
        if (!original) return;

        var origWalker = document.createTreeWalker(original, NodeFilter.SHOW_ELEMENT);
        var cloneWalker = document.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT);
        var records = [];

        while (origWalker.nextNode() && cloneWalker.nextNode()) {
            var cs;
            try { cs = window.getComputedStyle(origWalker.currentNode); } catch (e) { cs = null; }
            var tag = (origWalker.currentNode.tagName || '').toUpperCase();
            records.push({
                cloneEl: cloneWalker.currentNode,
                tag: tag,
                textAlign: cs ? cs.getPropertyValue('text-align') : 'start',
                fontWeight: cs ? cs.getPropertyValue('font-weight') : '400',
                fontStyle: cs ? cs.getPropertyValue('font-style') : 'normal',
                // Table-related properties (only used for TABLE/TR/TD/TH)
                borderCollapse: cs ? cs.getPropertyValue('border-collapse') : '',
                border: cs ? cs.getPropertyValue('border-top-width') : '',
                padding: cs ? cs.getPropertyValue('padding-top') : '',
                bgColor: cs ? cs.getPropertyValue('background-color') : '',
                vAlign: cs ? cs.getPropertyValue('vertical-align') : '',
                width: cs ? cs.getPropertyValue('width') : '',
            });
        }

        for (var i = records.length - 1; i >= 0; i--) {
            var rec = records[i];
            var el = rec.cloneEl;
            if (!el.parentNode) continue;
            var tag = el.tagName.toUpperCase();

            // --- Add MsoNormal class to all <p> so Word treats them natively ---
            if (tag === 'P') {
                var cls = el.getAttribute('class') || '';
                if (cls.indexOf('MsoNormal') === -1) {
                    el.setAttribute('class', (cls ? cls + ' ' : '') + 'MsoNormal');
                }
            }

            // --- Centering / right-alignment ---
            var targetAlign = null;
            if (rec.textAlign === 'center') targetAlign = 'center';
            else if (rec.textAlign === 'right') targetAlign = 'right';

            if (targetAlign) {
                if (/^(P|H[1-6]|TD|TH|LI)$/i.test(tag)) {
                    setInlineTextAlign(el, targetAlign);
                } else if (/^(DIV|SECTION|ARTICLE)$/i.test(tag)) {
                    var hasBlockChild = false;
                    for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
                        if (/^(P|DIV|TABLE|UL|OL|LI|H[1-6]|BLOCKQUOTE)$/i.test(c.tagName)) {
                            hasBlockChild = true;
                            break;
                        }
                    }
                    if (!hasBlockChild) {
                        changeTagToP(el, targetAlign);
                    } else {
                        var children = el.querySelectorAll('p, h1, h2, h3, h4, h5, h6, td, th, li');
                        for (var j = 0; j < children.length; j++) {
                            setInlineTextAlign(children[j], targetAlign);
                        }
                    }
                }
            }

            // --- Justify everything else (not center, not right) ---
            if (!targetAlign) {
                if (/^(P|LI|TD|TH)$/i.test(tag)) {
                    setInlineTextAlign(el, 'justify');
                } else if (tag === 'DIV') {
                    var hasBlock2 = false;
                    for (var c2 = el.firstElementChild; c2; c2 = c2.nextElementSibling) {
                        if (/^(P|DIV|TABLE|UL|OL|LI|H[1-6]|BLOCKQUOTE)$/i.test(c2.tagName)) {
                            hasBlock2 = true;
                            break;
                        }
                    }
                    if (!hasBlock2) {
                        changeTagToP(el, 'justify');
                    }
                }
            }

            // --- Table formatting: inline borders, padding, background ---
            if (/^(TABLE|TD|TH)$/i.test(tag)) {
                var tStyle = el.getAttribute('style') || '';
                // Remove any previously-set harmful/conflicting styles
                tStyle = tStyle.replace(/position\s*:[^;]+;?/gi, '');
                tStyle = tStyle.replace(/(?:top|left|right|bottom)\s*:[^;]+;?/gi, '');
                tStyle = tStyle.replace(/(?:margin(?:-top|-bottom|-left|-right)?)\s*:[^;]+;?/gi, '');
                tStyle = tStyle.trim();

                if (tag === 'TABLE') {
                    if (rec.borderCollapse && rec.borderCollapse !== 'separate') {
                        tStyle += ';border-collapse:' + rec.borderCollapse;
                    }
                    if (rec.width && rec.width !== 'auto' && rec.width !== '100%') {
                        tStyle += ';width:' + rec.width;
                    }
                }

                // Border: only if visible (width > 0)
                if (rec.border && rec.border !== '0px' && rec.border !== '0') {
                    tStyle += ';border:1px solid #000';
                }

                if (/^(TD|TH)$/i.test(tag)) {
                    if (rec.padding && rec.padding !== '0px') {
                        tStyle += ';padding:' + rec.padding;
                    } else {
                        tStyle += ';padding:4pt 6pt';
                    }
                    if (rec.bgColor && rec.bgColor !== 'rgba(0, 0, 0, 0)' && rec.bgColor !== 'transparent') {
                        tStyle += ';background-color:' + rec.bgColor;
                    }
                    if (rec.vAlign && rec.vAlign !== 'baseline' && rec.vAlign !== 'middle') {
                        tStyle += ';vertical-align:' + rec.vAlign;
                    }
                }

                tStyle = tStyle.replace(/^;+/, '').trim();
                if (tStyle) el.setAttribute('style', tStyle);
            }

            // --- Bold / Italic via inline style (for CSS-driven formatting) ---
            var isBold = parseInt(rec.fontWeight, 10) >= 600 || rec.fontWeight === 'bold';
            var isItalic = rec.fontStyle === 'italic' || rec.fontStyle === 'oblique';
            if ((isBold || isItalic) && /^(P|DIV|SPAN|H[1-6]|TD|TH|LI)$/i.test(tag)) {
                var hasBoldChild = el.querySelector('b, strong');
                var hasItalicChild = el.querySelector('i, em');
                var hasOwnText = false;
                for (var t = el.firstChild; t; t = t.nextSibling) {
                    if (t.nodeType === Node.TEXT_NODE && t.textContent.trim()) {
                        hasOwnText = true;
                        break;
                    }
                }
                if (hasOwnText) {
                    var st = el.getAttribute('style') || '';
                    if (isBold && !hasBoldChild) st += ';font-weight:bold';
                    if (isItalic && !hasItalicChild) st += ';font-style:italic';
                    st = st.replace(/^;+/, '').trim();
                    if (st) el.setAttribute('style', st);
                }
            }
        }
    }

    /** Set text-align as an inline style AND align attribute on an element.
     *  Also strips harmful positioning styles the site injects (absolute
     *  positioning, negative margins, etc.) that would corrupt Word output. */
    function setInlineTextAlign(el, align) {
        var st = el.getAttribute('style') || '';
        // Strip properties that are harmful in Word
        st = st.replace(/position\s*:[^;]+;?/gi, '');
        st = st.replace(/(?:top|left|right|bottom)\s*:[^;]+;?/gi, '');
        st = st.replace(/(?:margin-top|margin-bottom)\s*:-[^;]+;?/gi, '');
        st = st.replace(/visibility\s*:[^;]+;?/gi, '');
        st = st.replace(/z-index\s*:[^;]+;?/gi, '');
        st = st.replace(/text-align\s*:[^;]+;?/gi, '');
        st = st.replace(/;\s*$/, '').trim();
        st = (st ? st + '; ' : '') + 'text-align:' + align;
        el.setAttribute('style', st);
        el.setAttribute('align', align);
    }

    /** Replace `el` in-place with a <p> element carrying the alignment */
    function changeTagToP(el, alignVal) {
        var p = el.ownerDocument.createElement('p');
        p.setAttribute('class', 'MsoNormal');
        for (var i = 0; i < el.attributes.length; i++) {
            var name = el.attributes[i].name;
            if (name === 'class' || name === 'style') continue;
            p.setAttribute(name, el.attributes[i].value);
        }
        // Carry over any non-text-align styles from the original
        var oldStyle = (el.getAttribute('style') || '').replace(/text-align\s*:[^;]+;?/gi, '').replace(/;\s*$/, '').trim();
        if (oldStyle) p.setAttribute('style', oldStyle);
        setInlineTextAlign(p, alignVal);
        while (el.firstChild) {
            p.appendChild(el.firstChild);
        }
        el.parentNode.replaceChild(p, el);
    }

    /** Dump a sample of aligned elements to the console for diagnostics */
    function logAlignmentDiagnostics(clone) {
        try {
            var mso = clone.querySelectorAll('.MsoNormal');
            var centered = clone.querySelectorAll('[style*="text-align:center"], [style*="text-align: center"]');
            console.log('[NJT Copy] MsoNormal=' + mso.length + ' center=' + centered.length);
            for (var i = 0; i < Math.min(centered.length, 3); i++) {
                console.log('  ' + (i + 1) + '. ' + centered[i].outerHTML.substring(0, 180));
            }
        } catch (e) {
            console.warn('[NJT Copy] Diagnostics error:', e);
        }
    }

    /** Remove elements that became empty (no text, no children) after stripping */
    function cleanEmptyElements(root) {
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        var nodesToCheck = [];
        while (walker.nextNode()) {
            nodesToCheck.push(walker.currentNode);
        }
        // Process from bottom up
        for (var i = nodesToCheck.length - 1; i >= 0; i--) {
            var el = nodesToCheck[i];
            // Keep elements that are meaningful even if empty: img, br, hr, td, th
            if (/^(img|br|hr|td|th|input|col|colgroup|area|base|link|meta|param|source|track|wbr)$/i.test(el.tagName)) {
                continue;
            }
            // Check if the element has no visible content
            var hasContent = el.textContent.replace(/\s+/g, '').length > 0;
            var hasChildren = el.children.length > 0;
            var hasImg = el.querySelector('img') !== null;
            if (!hasContent && !hasImg && el.parentNode) {
                // Don't remove elements that have block-level formatting significance
                // like <p>, <div> with classes used for structure, <li>, etc.
                // Only remove truly empty wrappers
                if (el.children.length === 0 && !/^(p|div|li|td|th|tr|table|thead|tbody|tfoot|h[1-6]|section|article|ul|ol|dl|blockquote)$/i.test(el.tagName)) {
                    el.parentNode.removeChild(el);
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Plain text extraction from the cleaned clone
    // -----------------------------------------------------------------------

    function extractPlainText(clone) {
        var lines = [];

        /**
         * Recursively processes the DOM tree. Returns the text content
         * for inline elements so parent block elements can use it.
         * For block elements, appends to the global `lines` array and returns ''.
         * This avoids duplicating text from nested block elements.
         */
        function processNode(node) {
            if (!node) return '';
            if (node.nodeType === Node.TEXT_NODE) {
                return node.textContent;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return '';

            var tag = node.tagName.toUpperCase();

            // Skip non-content elements
            if (/^(SCRIPT|STYLE|NOSCRIPT|BUTTON|INPUT|SELECT|TEXTAREA)$/i.test(tag)) return '';

            // Special handling for tables: tab-separated cells, newline-separated rows
            if (tag === 'TABLE') {
                lines.push('');
                var rows = node.querySelectorAll('tr');
                for (var r = 0; r < rows.length; r++) {
                    var cells = rows[r].querySelectorAll('td, th');
                    var rowText = [];
                    for (var c = 0; c < cells.length; c++) {
                        rowText.push(cells[c].textContent.replace(/\s+/g, ' ').trim());
                    }
                    if (rowText.length > 0) lines.push(rowText.join('\t'));
                }
                lines.push('');
                return '';
            }

            // Determine if this element is block-level
            var isBlock = /^(H[1-6]|P|DIV|LI|SECTION|ARTICLE|BLOCKQUOTE|PRE|HR|BR|UL|OL|DL|DT|DD)$/i.test(tag);
            var isHeading = /^H[1-6]$/i.test(tag);

            // Collect text from all children recursively
            var childText = '';
            for (var child = node.firstChild; child; child = child.nextSibling) {
                childText += processNode(child);
            }

            // Collapse whitespace
            var trimmed = childText.replace(/\s+/g, ' ').trim();

            if (isBlock && trimmed.length > 0) {
                if (isHeading) {
                    lines.push('');
                    lines.push(trimmed.toUpperCase());
                    lines.push('');
                } else if (tag === 'LI') {
                    lines.push('  ' + trimmed);
                } else {
                    lines.push(trimmed);
                    lines.push('');
                }
                return ''; // text already consumed via lines array
            }

            // Inline elements: pass text up to parent
            if (!isBlock) {
                return childText;
            }

            return ''; // empty block element
        }

        processNode(clone);

        // Collapse excessive blank lines
        return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    // -----------------------------------------------------------------------
    // Build the complete HTML document for Word paste
    // -----------------------------------------------------------------------

    function buildWordHtml(contentHtml) {
        // Word recognizes HTML as "native" when it sees xmlns:o, xmlns:w,
        // @page WordSection1, MsoNormal class, and StartFragment markers.
        // The CF_HTML headers (Version/StartHTML/etc.) are added automatically
        // by the browser when we use execCommand('copy') — we must NOT include
        // them here or the format gets corrupted.
        return [
            '<html xmlns:o="urn:schemas-microsoft-com:office:office"',
            'xmlns:w="urn:schemas-microsoft-com:office:word"',
            'xmlns="http://www.w3.org/TR/REC-html40">',
            '<head>',
            '<meta http-equiv=Content-Type content="text/html; charset=utf-8">',
            '<style>',
            '<!--',
            'p.MsoNormal, li.MsoNormal, div.MsoNormal',
            '  {margin-top:0cm;margin-right:0cm;margin-bottom:6.0pt;margin-left:0cm;',
            '   text-align:justify;font-size:12.0pt;',
            '   font-family:"Times New Roman",serif;}',
            '@page WordSection1',
            '  {size:612.0pt 792.0pt;margin:70.85pt 70.85pt 70.85pt 70.85pt;}',
            'div.WordSection1 {page:WordSection1;}',
            'table {border-collapse:collapse;width:100%;margin:12pt 0;}',
            'table, th, td {border:1px solid #000;}',
            'th, td {padding:4pt 6pt;vertical-align:top;}',
            'th {background-color:#f0f0f0;font-weight:bold;}',
            'img {max-width:100%;height:auto;}',
            '-->',
            '</style>',
            '</head>',
            '<body lang=HU style="tab-interval:35.4pt;word-wrap:break-word">',
            '<!--StartFragment-->',
            contentHtml,
            '<!--EndFragment-->',
            '</body>',
            '</html>',
        ].join('\n');
    }

    // -----------------------------------------------------------------------
    // Clipboard operations
    // -----------------------------------------------------------------------

    /**
     * Copy HTML and plain text to clipboard.
     * Uses execCommand('copy') first because it triggers the browser's
     * native clipboard write (same as Ctrl+C), which produces the exact
     * CF_HTML format Word expects.  ClipboardItem is the fallback.
     */
    function copyToClipboard(htmlContent, plainText) {
        // PRIMARY: execCommand on a hidden contenteditable — this is
        // the same mechanism the browser uses for Ctrl+C, producing
        // properly formatted CF_HTML that Word recognizes.
        try {
            var container = document.createElement('div');
            container.setAttribute('contenteditable', 'true');
            container.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;';
            container.innerHTML = htmlContent;
            document.body.appendChild(container);

            var range = document.createRange();
            range.selectNodeContents(container);
            var sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);

            var success = document.execCommand('copy');
            sel.removeAllRanges();
            document.body.removeChild(container);

            if (success) return Promise.resolve();
        } catch (e) {
            // fall through to ClipboardItem
        }

        // FALLBACK: ClipboardItem API
        if (typeof ClipboardItem === 'function' && navigator.clipboard && navigator.clipboard.write) {
            var blobHtml = new Blob([htmlContent], { type: 'text/html' });
            var blobText = new Blob([plainText], { type: 'text/plain' });
            try {
                var item = new ClipboardItem({
                    'text/html': blobHtml,
                    'text/plain': blobText,
                });
                return navigator.clipboard.write([item]);
            } catch (e2) {
                try {
                    var item2 = new ClipboardItem({ 'text/html': blobHtml });
                    return navigator.clipboard.write([item2]);
                } catch (e3) {
                    return Promise.reject(new Error('Clipboard write failed: ' + e3.message));
                }
            }
        }

        return Promise.reject(new Error('No clipboard method available'));
    }

    // -----------------------------------------------------------------------
    // UI: Button and progress indicator
    // -----------------------------------------------------------------------

    var BUTTON_ID = 'njt-copy-word-btn';
    var TOAST_ID = 'njt-copy-toast';

    /** Create or get the copy button */
    function getOrCreateButton() {
        var existing = document.getElementById(BUTTON_ID);
        if (existing) return existing;

        var btn = document.createElement('button');
        btn.id = BUTTON_ID;
        btn.textContent = 'Másolás Word-be';
        btn.title = 'A teljes jogszabály szövegének másolása vágólapra Word-be illeszthető formátumban.\nBeszúrás után Wordben válaszd a "Forrásformátum megőrzése" lehetőséget!';
        btn.setAttribute('aria-label', 'Jogszabály másolása Word formátumban');
        btn.style.cssText = [
            'position: fixed',
            'bottom: 24px',
            'right: 24px',
            'z-index: 99999',
            'padding: 10px 20px',
            'background: #1a5c8a',
            'color: #fff',
            'border: none',
            'border-radius: 6px',
            'font-size: 14px',
            'font-family: Arial, sans-serif',
            'cursor: pointer',
            'box-shadow: 0 2px 8px rgba(0,0,0,0.3)',
            'transition: background 0.2s, opacity 0.2s',
        ].join(';');

        btn.addEventListener('mouseenter', function () {
            btn.style.background = '#1e6ea8';
        });
        btn.addEventListener('mouseleave', function () {
            btn.style.background = '#1a5c8a';
        });

        btn.addEventListener('click', handleCopyClick);

        document.body.appendChild(btn);
        return btn;
    }

    /** Create or get the toast / progress indicator */
    function getOrCreateToast() {
        var existing = document.getElementById(TOAST_ID);
        if (existing) return existing;

        var toast = document.createElement('div');
        toast.id = TOAST_ID;
        toast.style.cssText = [
            'position: fixed',
            'bottom: 80px',
            'right: 24px',
            'z-index: 100000',
            'padding: 10px 18px',
            'background: rgba(0,0,0,0.85)',
            'color: #fff',
            'border-radius: 6px',
            'font-size: 13px',
            'font-family: Arial, sans-serif',
            'display: none',
            'pointer-events: none',
            'transition: opacity 0.3s',
            'max-width: 320px',
        ].join(';');
        document.body.appendChild(toast);
        return toast;
    }

    function showToast(text, isError) {
        var toast = getOrCreateToast();
        toast.textContent = text;
        toast.style.display = 'block';
        toast.style.opacity = '1';
        toast.style.background = isError ? 'rgba(180,40,40,0.9)' : 'rgba(0,0,0,0.85)';
        clearTimeout(toast._hideTimer);
        toast._hideTimer = setTimeout(function () {
            toast.style.opacity = '0';
            setTimeout(function () {
                toast.style.display = 'none';
            }, 300);
        }, 4000);
    }

    function setButtonProgress(inProgress) {
        var btn = document.getElementById(BUTTON_ID);
        if (!btn) return;
        if (inProgress) {
            btn.textContent = 'Szöveg betöltése...';
            btn.style.opacity = '0.7';
            btn.style.pointerEvents = 'none';
            btn.style.cursor = 'wait';
        } else {
            btn.textContent = 'Másolás Word-be';
            btn.style.opacity = '1';
            btn.style.pointerEvents = 'auto';
            btn.style.cursor = 'pointer';
        }
    }

    // -----------------------------------------------------------------------
    // Main copy handler
    // -----------------------------------------------------------------------

    function handleCopyClick(e) {
        e.preventDefault();
        e.stopPropagation();

        var btn = getOrCreateButton();

        // Prevent double-clicks
        if (btn._inProgress) return;
        btn._inProgress = true;
        setButtonProgress(true);
        showToast('Teljes szöveg betöltése...');

        // Step 1: find the scroll container
        var scrollContainer = getScrollContainer();

        // Step 2: scroll through full content to trigger any lazy-loading
        ensureAllContentLoaded(scrollContainer)
            .then(function () {
                showToast('Szöveg feldolgozása...');

                // Step 3: wait a moment for any late DOM mutations
                var contentEl = findContentElement();
                var targetForObserver = contentEl || document.body;
                return waitForDomStability(targetForObserver, 500, 3000);
            })
            .then(function () {
                // Step 4: find content element (again, may have changed)
                var contentEl = findContentElement();
                if (!contentEl) {
                    throw new Error('Nem található a jogszabály tartalma az oldalon.');
                }

                // Step 5: clean and clone
                showToast('Másolás előkészítése...');
                var cleaned = cleanContent(contentEl);

                // Step 6: copy via ClipboardItem API.  If the tab lost
                // focus while scrolling (user switched away), wait for
                // focus to return before writing.
                showToast('Másolás vágólapra...');
                var contentHtml = cleaned.outerHTML || cleaned.innerHTML;
                var plainText = extractPlainText(cleaned);

                if (typeof ClipboardItem !== 'function' || !navigator.clipboard || !navigator.clipboard.write) {
                    throw new Error('A böngésző nem támogatja a vágólap API-t');
                }

                var blobHtml = new Blob([contentHtml], { type: 'text/html' });
                var blobText = new Blob([plainText], { type: 'text/plain' });
                var item = new ClipboardItem({
                    'text/html': blobHtml,
                    'text/plain': blobText,
                });

                // Promise-based retry loop with focus detection
                return new Promise(function (resolve, reject) {
                    function tryWrite() {
                        if (!document.hasFocus()) {
                            showToast('Válts vissza erre a fülre a másoláshoz...');
                            var onFocus = function () {
                                window.removeEventListener('focus', onFocus);
                                showToast('Másolás vágólapra...');
                                // Small delay to let the browser register focus
                                setTimeout(tryWrite, 300);
                            };
                            window.addEventListener('focus', onFocus);
                            return;
                        }
                        navigator.clipboard.write([item]).then(resolve, function (err) {
                            if (err.name === 'NotAllowedError') {
                                // Document lost focus between check and write — retry
                                setTimeout(tryWrite, 500);
                            } else {
                                reject(err);
                            }
                        });
                    }
                    tryWrite();
                });
            })
            .then(function () {
                showToast('Kész! Illeszd be Wordbe (Ctrl+V), majd válaszd a "Forrásformátum megőrzése" lehetőséget!');
            })
            .catch(function (err) {
                console.error('[NJT Copy] Hiba:', err);
                showToast('Hiba: ' + (err.message || 'A másolás nem sikerült'), true);
            })
            .finally(function () {
                btn._inProgress = false;
                setButtonProgress(false);
            });
    }

    // -----------------------------------------------------------------------
    // SPA navigation handling – reinitialize on URL changes
    // -----------------------------------------------------------------------

    var lastUrl = location.href;
    var initRun = false;
    var initRetries = 0;

    function onUrlChange() {
        if (location.href === lastUrl) return;
        lastUrl = location.href;
        initRun = false;           // reset for new page
        initRetries = 0;

        var oldBtn = document.getElementById(BUTTON_ID);
        if (oldBtn && oldBtn.parentNode) oldBtn.parentNode.removeChild(oldBtn);

        setTimeout(initialize, 300);
    }

    // Monkey-patch history API
    var origPushState = history.pushState;
    history.pushState = function () {
        var result = origPushState.apply(this, arguments);
        onUrlChange();
        return result;
    };

    var origReplaceState = history.replaceState;
    history.replaceState = function () {
        var result = origReplaceState.apply(this, arguments);
        onUrlChange();
        return result;
    };

    window.addEventListener('popstate', function () {
        onUrlChange();
    });

    // Also watch for hash changes
    window.addEventListener('hashchange', function () {
        onUrlChange();
    });

    // -----------------------------------------------------------------------
    // Initialization
    // -----------------------------------------------------------------------

    function initialize() {
        if (!/\/jogszabaly\//.test(location.pathname)) {
            var oldBtn = document.getElementById(BUTTON_ID);
            if (oldBtn && oldBtn.parentNode) oldBtn.parentNode.removeChild(oldBtn);
            return;
        }

        var contentEl = findContentElement();
        if (!contentEl) {
            initRetries++;
            if (initRetries < 10) {
                setTimeout(initialize, 500);
            }
            return;
        }

        getOrCreateButton();
        getOrCreateToast();
        initRun = true;
    }

    // Wait for DOM ready because Tampermonkey starts us at document-start.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            setTimeout(initialize, 500);
        });
    } else {
        setTimeout(initialize, 500);
    }

    // Additional observer to catch late DOM insertions (Angular rendering).
    // Deferred until body exists (at document-start it may be null).
    var bodyObserver = null;
    function ensureObserver() {
        if (bodyObserver) return;
        if (!document.body) { setTimeout(ensureObserver, 100); return; }
        bodyObserver = new MutationObserver(function (mutations) {
            // Watch for the site wrapping selection in highlight spans
            for (var mi = 0; mi < mutations.length; mi++) {
                var m = mutations[mi];
                for (var ni = 0; ni < m.addedNodes.length; ni++) {
                    var node = m.addedNodes[ni];
                    if (node.nodeType === 1) {
                        var tag = node.tagName.toUpperCase();
                        var cls = (node.getAttribute('class') || '').toLowerCase();
                        // Site wraps selection in <span> with highlight styling
                        if (tag === 'SPAN' && (cls.indexOf('highlight') !== -1 ||
                            (node.getAttribute('style') || '').indexOf('#DCEFFD') !== -1)) {
                            // Unwrap: move children out, remove span
                            while (node.firstChild) {
                                node.parentNode.insertBefore(node.firstChild, node);
                            }
                            node.parentNode.removeChild(node);
                        }
                    }
                }
            }
            // Original button-creation logic
            var contentEl = findContentElement();
            if (contentEl && !document.getElementById(BUTTON_ID) && /\/jogszabaly\//.test(location.pathname)) {
                getOrCreateButton();
                getOrCreateToast();
            }
        });
        bodyObserver.observe(document.body, { childList: true, subtree: true });
    }
    ensureObserver();

    // Periodic URL check for SPA navigations that bypass history API
    setInterval(function () {
        if (location.href !== lastUrl) onUrlChange();
    }, 1000);

    // Periodic cleanup: nuke any onselectstart/oncontextmenu the site
    // may have set via direct property assignment on specific elements
    setInterval(function () {
        if (document.body) {
            document.onselectstart = null;
            document.oncontextmenu = null;
        }
    }, 2000);

})();
