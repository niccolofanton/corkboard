// The script injected at the top of every snippet's `srcdoc`, before the author's HTML, and the protocol the
// layer speaks to it. The frame has an opaque origin, so messages go both ways with `postMessage`; the script
// only listens to its parent (`event.source === parent`), the layer only to the frame it mounted.
//
//   layer -> frame  { cb, op: 'pause' }                 pause CSS / Web animations and hold requestAnimationFrame,
//                                                       setTimeout and setInterval
//                   { cb, op: 'resume' }
//                   { cb, op: 'snapshot', id, vw, vh }  the document at its CURRENT state, as SVG markup; vw x vh is
//                                                       the size it is laid out at, for when the window reports 0
//   frame -> layer  { cb, op: 'snapshot', id, ok, svg? }
//
// The snapshot clones the document (its stylesheets come along), bakes in the current value of whatever
// CSS / Web animations and transitions are changing, turns canvases into images, and returns the SVG
// `<foreignObject>` markup; the layer draws it onto a canvas (the parent is never throttled). The CSP of the
// frame already allows what that needs: inline scripts (`script-src 'unsafe-inline'`) and `data:` images
// (`img-src data:`), so it is not loosened.

export const EMBED_CB = 'corkboard-embed';

// Longest side of a snapshot, in px.
export const SNAPSHOT_MAX_SIDE = 640;
// The layer gives up on a frame's answer after this long (a busy page delays the messages, not the work).
export const SNAPSHOT_MS = 4000;

export type EmbedOp = 'pause' | 'resume' | 'snapshot';

// Written readable below; shipped without its whole-line comments and indentation (it goes into every snippet).
const SOURCE = `(function () {
var CB = '${EMBED_CB}';
var raf = window.requestAnimationFrame.bind(window), caf = window.cancelAnimationFrame.bind(window);
var paused = false, n = 0, pend = {}, hand = {}, stopped = [];
var st = window.setTimeout.bind(window), ct = window.clearTimeout.bind(window);
var si = window.setInterval.bind(window), ci = window.clearInterval.bind(window);
var tm = {}, tn = 0, held = [];

// requestAnimationFrame behind a gate: while paused, callbacks wait and run on resume.
function sched(id) {
  hand[id] = raf(function (t) { var f = pend[id]; delete hand[id]; delete pend[id]; f(t); });
}
window.requestAnimationFrame = function (f) {
  var id = ++n;
  pend[id] = f;
  if (!paused) sched(id);
  return id;
};
window.cancelAnimationFrame = function (id) {
  if (hand[id] !== undefined) caf(hand[id]);
  delete hand[id];
  delete pend[id];
};

// setTimeout / setInterval behind the same gate: a callback that falls due while paused waits and runs once on
// resume (an interval then goes on with its own schedule). The ids are ours; either clear accepts them.
function timer(set, clear, again) {
  return function (f, ms) {
    if (typeof f !== 'function') return set.apply(window, arguments);
    var args = [].slice.call(arguments, 2), t = { id: ++tn, held: false, clear: clear };
    t.go = function () {
      if (!again) delete tm[t.id];
      f.apply(window, args);
    };
    t.h = set(function () {
      if (!paused) t.go();
      else if (!t.held) { t.held = true; held.push(t); }
    }, ms);
    tm[t.id] = t;
    return t.id;
  };
}
function untimer(id) {
  var t = tm[id];
  if (!t) return ct(id);
  delete tm[id];
  t.held = false;
  t.clear(t.h);
}
window.setTimeout = timer(st, ct, false);
window.setInterval = timer(si, ci, true);
window.clearTimeout = window.clearInterval = untimer;

function setPaused(p) {
  if (p === paused) return;
  paused = p;
  var id;
  if (p) {
    for (id in hand) { caf(hand[id]); delete hand[id]; }
    stopped = document.getAnimations().filter(function (a) { return a.playState === 'running'; });
    stopped.forEach(function (a) { a.pause(); });
  } else {
    for (id in pend) if (hand[id] === undefined) sched(id);
    stopped.forEach(function (a) { if (a.playState === 'paused') a.play(); });
    stopped = [];
    held.splice(0).forEach(function (t) {
      if (!t.held) return;
      t.held = false;
      st(function () { if (tm[t.id] === t) t.go(); }, 0);
    });
  }
}

// The clone keeps the stylesheets: bake only what animations change (all computed styles took seconds).
function animated() {
  var m = new Map();
  document.getAnimations().forEach(function (a) {
    var ef = a.effect;
    if (!ef || !ef.target || ef.pseudoElement || !ef.getKeyframes) return;
    var s = m.get(ef.target) || new Set();
    if (a.transitionProperty) s.add(a.transitionProperty);
    ef.getKeyframes().forEach(function (k) {
      for (var p in k) {
        if (p === 'offset' || p === 'easing' || p === 'composite' || p === 'computedOffset') continue;
        s.add(p === 'cssFloat' ? 'float' : p.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); }));
      }
    });
    m.set(ef.target, s);
  });
  return m;
}

// Canvases become data: URLs; network images stay blank (unreadable here). Scripts go.
function bake(o, c, props) {
  var tag = o.tagName, css = '', cs;
  if (tag === 'SCRIPT') return c.remove();
  if (props) {
    cs = getComputedStyle(o);
    props.forEach(function (p) { css += p + ':' + cs.getPropertyValue(p) + ';'; });
    c.setAttribute('style', (c.getAttribute('style') || '') + ';' + css);
  }
  if (tag === 'CANVAS') {
    cs = cs || getComputedStyle(o);
    var im = document.createElement('img');
    im.src = o.toDataURL(); // throws on a tainted canvas: no snapshot rather than a blank one
    im.setAttribute('style', (c.getAttribute('style') || '') + ';width:' + cs.width + ';height:' + cs.height +
      ';display:' + cs.display);
    c.replaceWith(im);
  }
}

// The SVG markup of the document as it is now. Rasterising happens in the parent: a small frame is
// throttled by the browser, and an image decode or toBlob in it can wait for seconds.
function snapshot(vw, vh) {
  var de = document.documentElement, W = innerWidth || vw, H = innerHeight || vh;
  if (!(W > 0 && H > 0)) return null;
  var from = [de].concat([].slice.call(de.querySelectorAll('*')));
  var clone = de.cloneNode(true);
  var to = [clone].concat([].slice.call(clone.querySelectorAll('*')));
  if (from.length !== to.length || from.length > 3000) return null;
  var anim = animated();
  for (var i = 0; i < from.length; i++) bake(from[i], to[i], anim.get(from[i]));
  clone.style.width = W + 'px';
  clone.style.height = H + 'px';
  var st = document.createElement('style');
  st.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}';
  (clone.querySelector('head') || clone).appendChild(st);
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '">' +
    '<foreignObject width="100%" height="100%">' + new XMLSerializer().serializeToString(clone) +
    '</foreignObject></svg>';
}

// A page with no background of its own would show the card's poster through it: give it the white a
// browser tab would. A colour or an image on the root or the body (a gradient) wins.
addEventListener('DOMContentLoaded', function () {
  function bare(el) {
    if (!el) return true;
    var cs = getComputedStyle(el), c = cs.backgroundColor;
    return cs.backgroundImage === 'none' && (c === 'transparent' || /^rgba\(.*,\s*0\)$/.test(c));
  }
  if (bare(document.documentElement) && bare(document.body)) document.documentElement.style.backgroundColor = '#fff';
});

addEventListener('message', function (e) {
  var d = e.data;
  if (e.source !== parent || !d || d.cb !== CB) return;
  if (d.op === 'pause') setPaused(true);
  else if (d.op === 'resume') setPaused(false);
  else if (d.op === 'snapshot') {
    var svg = null;
    try { svg = snapshot(d.vw, d.vh); } catch (err) { svg = null; }
    // The parent's origin is known from its message; an opaque one cannot be a target.
    parent.postMessage({ cb: CB, op: 'snapshot', id: d.id, ok: !!svg, svg: svg || undefined }, e.origin === 'null' ? '*' : e.origin);
  }
});
})();`;

export const SNIPPET_BOOTSTRAP = SOURCE.replace(/^[ \t]*\/\/.*\n/gm, '').replace(/^[ \t]+/gm, '');

