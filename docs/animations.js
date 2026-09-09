(function () {
  const targets = document.querySelectorAll(
    'main h2, main .feature, main .card, main .stat-row, main .callout, ' +
    'main table, main .bench-row, main pre, main .kv, main .result-block'
  );
  if (targets.length === 0) return;

  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReduced || !('IntersectionObserver' in window)) {
    targets.forEach((el) => el.classList.add('is-visible'));
    return;
  }

  // Bench bars animate their own width in from 0 once revealed, on top of
  // the shared fade/slide -- captured before .reveal ever hides anything,
  // since the inline width is the real benchmark value the page renders.
  const benchFills = new Map();
  document.querySelectorAll('.bench-row .bench-fill').forEach((el) => {
    benchFills.set(el, el.style.width);
    el.style.width = '0%';
  });

  targets.forEach((el) => el.classList.add('reveal'));

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-visible');
        const fill = entry.target.querySelector?.('.bench-fill');
        if (fill && benchFills.has(fill)) {
          requestAnimationFrame(() => { fill.style.width = benchFills.get(fill); });
        }
        io.unobserve(entry.target);
      }
    },
    { threshold: 0.1, rootMargin: '0px 0px -40px 0px' }
  );
  targets.forEach((el) => io.observe(el));
})();
