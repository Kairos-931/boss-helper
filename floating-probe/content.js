(() => {
  'use strict';

  // One static host; no business nodes, observers, timers, or event handlers.
  const hostId = 'boss-floating-probe-v1';
  if (document.getElementById(hostId)) return;

  const host = document.createElement('div');
  host.id = hostId;
  host.style.cssText = `
    all: initial !important;
    position: fixed !important;
    top: 45% !important;
    right: 12px !important;
    width: 40px !important;
    height: 40px !important;
    display: block !important;
    z-index: 2147483647 !important;
    pointer-events: none !important;
  `;

  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    .ball {
      box-sizing: border-box;
      display: grid;
      place-items: center;
      width: 40px;
      height: 40px;
      border: 1px solid rgba(255, 255, 255, .85);
      border-radius: 50%;
      background: #5964b6;
      color: #fff;
      box-shadow: 0 2px 10px rgba(35, 40, 80, .2);
      font: 500 14px/1 system-ui, sans-serif;
      user-select: none;
    }
  `;
  const ball = document.createElement('div');
  ball.className = 'ball';
  ball.textContent = '试';
  ball.setAttribute('aria-label', '悬浮球测试，无操作功能');
  shadow.append(style, ball);
  document.documentElement.append(host);
})();
