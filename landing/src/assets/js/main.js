/* Shortfall landing: live FDA counter, shelf-gap scroll scene, video facade. */
(function () {
  'use strict';

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- Live shortage counter ---------- */
  var countEl = document.getElementById('fda-count');
  var dateEl = document.getElementById('fda-date');
  function renderCount(count, date) {
    if (countEl && count != null) countEl.textContent = Number(count).toLocaleString('en-US');
    if (dateEl && date) dateEl.textContent = date;
  }
  if (countEl) {
    fetch('https://api.fda.gov/drug/shortages.json?count=status')
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (body) {
        var rows = body.results || [];
        var current = rows.filter(function (r) { return r.term === 'Current'; })[0];
        if (!current) throw new Error('no Current term');
        renderCount(current.count, body.meta && body.meta.last_updated);
      })
      .catch(function () {
        // Fall back to the value captured at build time.
        fetch('/fda-count.json')
          .then(function (r) { return r.json(); })
          .then(function (d) { renderCount(d.count, d.lastUpdated); })
          .catch(function () { /* baked-in HTML values already visible */ });
      });
  }

  /* ---------- Shelf-gap scroll scene ---------- */
  var stage = document.querySelector('.shelf-stage');
  var scene = document.querySelector('.shelf-scene');
  if (stage && scene && !reduced) {
    var clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };
    var ticking = false;
    var update = function () {
      ticking = false;
      var rect = stage.getBoundingClientRect();
      var total = rect.height - window.innerHeight;
      var p = total > 0 ? clamp(-rect.top / total, 0, 1) : 0;
      // Vial lifts out during first 40%, returns in the last 30%.
      var lift = p < 0.4 ? p / 0.4 : p > 0.7 ? Math.max(0, (1 - p) / 0.3) : 1;
      // Gap outline appears once the vial has left.
      var gap = clamp((lift - 0.6) / 0.4, 0, 1);
      // Connectors draw while the vial is out, retract before it returns.
      var draw = p < 0.2 ? 0 : p > 0.65 ? clamp((1 - p) / 0.35, 0, 1) : clamp((p - 0.2) / 0.3, 0, 1);
      scene.style.setProperty('--lift', lift.toFixed(3));
      scene.style.setProperty('--gap', gap.toFixed(3));
      scene.style.setProperty('--draw', draw.toFixed(3));
      scene.style.setProperty('--card-o', draw.toFixed(3));
    };
    window.addEventListener('scroll', function () {
      if (!ticking) { ticking = true; requestAnimationFrame(update); }
    }, { passive: true });
    update();
  } else if (scene) {
    scene.style.setProperty('--lift', '1');
    scene.style.setProperty('--gap', '1');
    scene.style.setProperty('--draw', '1');
    scene.style.setProperty('--card-o', '1');
  }

  /* ---------- YouTube facade (loads player only on click) ---------- */
  var facade = document.querySelector('.video-facade');
  if (facade) {
    facade.addEventListener('click', function () {
      var src = facade.getAttribute('data-embed');
      if (!src || src.indexOf('TODO') !== -1) {
        facade.querySelector('.hint').textContent = 'Demo video coming soon.';
        return;
      }
      var iframe = document.createElement('iframe');
      iframe.src = src + (src.indexOf('?') === -1 ? '?' : '&') + 'autoplay=1';
      iframe.title = 'Shortfall demo video';
      iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture');
      iframe.setAttribute('allowfullscreen', '');
      facade.innerHTML = '';
      facade.appendChild(iframe);
    });
  }
})();
