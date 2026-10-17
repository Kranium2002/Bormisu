// Key features slide: key tile n opens on step n and stays open; nothing else moves.
window.bentoStep = function (grid, step) {
  grid.querySelectorAll('[data-key]').forEach((t) => t.classList.toggle('open', +t.dataset.key <= step));
};
