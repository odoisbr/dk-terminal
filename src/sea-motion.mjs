// Animation adapted from the SEA motion supplied with the project.
// SVG paths and original timeline are retained; the startup duration is scaled.
export function playSeaMotion(stage, env = globalThis) {
  const fallback = { finishBy: 0, complete: () => {} };
  if (!stage || !stage.ownerDocument?.body) return fallback;
  const body = stage.ownerDocument.body;
  try {
    if (env.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return fallback;

    const $ = id => stage.querySelector(`#${id}`);

    const CX = 400, CY = 250, R = 150;
    const CIRC = 2 * Math.PI * R;
    const NX = 300;   // colunas de água ao longo do círculo

    const K1 = (2 * Math.PI) / 220;
    const K2 = (2 * Math.PI) / 140;
    const W1 = (2 * Math.PI) / 1.6;
    const W2 = (2 * Math.PI) / 1.1;
    const FK = (2 * Math.PI) / 120;
    const FW = (2 * Math.PI) / 1.2;

    const ring = $('ring');
    const grey = $('grey');
    const white = $('white');
    const exact = $('exact');
    const vlogo = $('vlogo');
    const vWord = $('vWord');

    ring.setAttribute('stroke-dasharray', CIRC);

    const ease = x => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
    const clamp = x => Math.min(1, Math.max(0, x));
    const clampv = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    const step = (a, b, t) => ease(clamp((t - a) / (b - a)));
    const lerp = (a, b, k) => a + (b - a) * k;

    // Coordenadas do símbolo no centro da tela, na escala final.
    const box = $('src').getBBox();
    const UI = box.x + box.width / 2;
    const VI = box.y + box.height / 2;
    const SL = (2 * R) / box.width; // o símbolo tem a mesma largura que o aro
    // o fundo do símbolo encosta na borda de baixo do aro
    const SYM_CY = CY + R - (SL * box.height) / 2;
    // o logo vertical é o mesmo símbolo ampliado: 576,1 unidades de largura contra box.width
    const V_SYMBOL_W = 576.1;
    const V_SCALE = SL / (V_SYMBOL_W / box.width);
    const V_H = 908 * V_SCALE;                   // altura do logo vertical completo
    const V_TOP_START = SYM_CY + SL * (box.y - VI); // topo do símbolo, onde ele está hoje
    const V_TOP_END = CY - V_H / 2;              // o conjunto fica centralizado no quadro
    const V_X = CX + SL * (box.x - UI);
    const toScreen = p => ({ x: CX + SL * (p.x - UI), y: SYM_CY + SL * (p.y - VI) });
    exact.setAttribute('transform', `translate(${CX} ${SYM_CY}) scale(${SL}) translate(${-UI} ${-VI})`);

    const X0 = CX - R;
    const CW = (2 * R) / NX;
    const xs = Array.from({ length: NX }, (_, j) => X0 + (j + 0.5) * CW);
    const xn = xs.map(x => (x - X0) / (2 * R));

    function sampleSym(path, n) {
      const L = path.getTotalLength();
      const pts = [];
      for (let i = 0; i <= n; i++) pts.push(toScreen(path.getPointAtLength((L * i) / n)));
      return pts;
    }

    // Para cada coluna, a menor e a maior altura do contorno. Colunas sem contorno herdam a vizinha.
    function columnEdges(points) {
      const min = Array(NX).fill(Infinity);
      const max = Array(NX).fill(-Infinity);
      const has = Array(NX).fill(false);
      for (const p of points) {
        const j = Math.min(NX - 1, Math.max(0, Math.floor((p.x - X0) / CW)));
        has[j] = true;
        min[j] = Math.min(min[j], p.y);
        max[j] = Math.max(max[j], p.y);
      }
      const from = has.map((_, j) => {
        for (let k = 1; ; k++) {
          if (j - k >= 0 && has[j - k]) return j - k;
          if (j + k < NX && has[j + k]) return j + k;
        }
      });
      for (let j = 0; j < NX; j++) {
        if (!has[j]) { min[j] = min[from[j]]; max[j] = max[from[j]]; }
      }
      return { min, max, has };
    }

    // Alvo final: a camada de cima é o topo da forma cinza, e a de baixo é o topo e o fundo do bojo branco.
    const bowlE = columnEdges(sampleSym($('srcBowl'), 1500));
    const bumpE = columnEdges(sampleSym($('srcBump'), 1500).concat(sampleSym($('srcTail'), 700)));
    const TARGET = {
      s1: bowlE.min,
      bot: bowlE.max.map((v, j) => (bowlE.has[j] ? Math.max(v, bowlE.min[j]) : bowlE.min[j])),
      s2: bumpE.min.map((v, j) => (bumpE.has[j] ? Math.min(v, bowlE.min[j]) : bowlE.min[j])),
    };

    // Superfícies de onda por coluna, no círculo. s1: topo da camada branca; s2: topo da cinza; bot: fundo do círculo.
    function waveSurfaces(fill, t) {
      const base = CY + R - 2 * fill * R;
      const a1 = 0.3 * Math.sin((W1 / 2) * t);
      const a2 = 0.45 * Math.sin((W1 / 2) * t + 1.9);
      const s1 = [];
      const s2 = [];
      const bot = [];
      for (let j = 0; j < NX; j++) {
        const dx = xs[j] - CX;
        const half = Math.sqrt(Math.max(0, R * R - dx * dx));
        const ctop = CY - half;
        const cbot = CY + half;
        const v1 = clampv(
          base + a1 * dx + 11 * Math.sin(K1 * dx + W1 * t) + 0.45 * 11 * Math.sin(K2 * dx - W2 * t + 1.3),
          ctop, cbot,
        );
        const v2 = clampv(
          base - 14 + a2 * dx + 20 * Math.sin(K1 * dx + W1 * t + 1.9) + 0.45 * 20 * Math.sin(K2 * dx - W2 * t + 3.2),
          ctop, v1,
        );
        s1.push(v1);
        s2.push(v2);
        bot.push(cbot);
      }
      return { s1, s2, bot };
    }

    // Cada coluna vira o símbolo quando a onda passa por ela; a onda ainda ondula até travar.
    function settle(W, t) {
      const s1 = [];
      const s2 = [];
      const bot = [];
      for (let j = 0; j < NX; j++) {
        const dx = xs[j] - CX;
        const p = ease(clamp((t - 4.0 - 1.6 * xn[j] + 0.08 * Math.sin(FK * dx - FW * t)) / 1.2));
        // nada sai do aro: cada coluna fica dentro do círculo enquanto se transforma
        const half = Math.sqrt(Math.max(0, R * R - dx * dx));
        const ctop = CY - half;
        const cbot = CY + half;
        const b = clampv(lerp(W.bot[j], TARGET.bot[j], p), ctop, cbot);
        const a1 = clampv(lerp(W.s1[j], TARGET.s1[j], p), ctop, b);
        const a2 = clampv(lerp(W.s2[j], TARGET.s2[j], p), ctop, a1);
        s1.push(a1);
        s2.push(a2);
        bot.push(b);
      }
      return { s1, s2, bot };
    }

    // Corpo entre duas superfícies: vai da esquerda para a direita pelo topo e volta pelo fundo.
    function bodyPath(top, bottom) {
      const pts = xs.map((x, j) => ({ x, y: top[j] }));
      for (let j = NX - 1; j >= 0; j--) pts.push({ x: xs[j], y: bottom[j] });
      return polyPath(pts);
    }

    function polyPath(pts) {
      let d = '';
      for (let i = 0; i < pts.length; i++) {
        d += `${i ? 'L' : 'M'}${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)}`;
      }
      return `${d}Z`;
    }

    // Linha do tempo (segundos)
    const DURATION = 9.4;

    function render(t) {
      // 0–0.9s: a linha branca do círculo se desenha; 6.8–7.4s: ela some com fade
      ring.setAttribute('stroke-dasharray', CIRC);
      ring.setAttribute('stroke-dashoffset', (CIRC * (1 - step(0, 0.9, t))).toFixed(2));
      ring.setAttribute('opacity', (1 - step(6.8, 7.4, t)).toFixed(3));

      // 0.9–2.3s: a água sobe até a metade e balança; 4.0–6.8s: as ondas assentam no símbolo
      const W = waveSurfaces(0.5 * step(0.9, 2.3, t), t);
      const S = t < 4.0 ? W : settle(W, t);
      const locked = t >= 6.8;

      grey.setAttribute('display', locked ? 'none' : 'inline');
      white.setAttribute('display', locked ? 'none' : 'inline');
      if (!locked) {
        grey.setAttribute('d', bodyPath(S.s2, S.s1));
        white.setAttribute('d', bodyPath(S.s1, S.bot));
      }

      // 6.8–7.4s: o símbolo exato; a partir de 7.4s, o símbolo do logo vertical, na mesma posição
      exact.setAttribute('display', locked && t < 7.4 ? 'inline' : 'none');
      const formed = t >= 7.4;
      vlogo.setAttribute('display', formed ? 'inline' : 'none');

      // 7.4–8.4s: o conjunto sobe para o centro do quadro enquanto o texto aparece com fade
      const k = ease(clamp((t - 7.4) / 1.0));
      const top = lerp(V_TOP_START, V_TOP_END, k);
      vWord.setAttribute('opacity', k.toFixed(3));

      // 8.4–9.4s: depois de formado, o conjunto faz um zoom-in suave a partir do centro
      const z = 1 + 0.05 * ease(clamp((t - 8.4) / 1.0));
      vlogo.setAttribute('transform',
        `translate(400 250) scale(${z.toFixed(4)}) translate(-400 -250) translate(${V_X.toFixed(2)} ${top.toFixed(2)}) scale(${V_SCALE.toFixed(5)})`);
    }


    // Fit the 9.4-second source timeline into the existing startup window.
    // Limit expensive SVG path generation to at most 30 frames per second.
    const playbackSeconds = 1.2;
    const started = env.performance.now();
    let raf = 0, previous = -Infinity, stopped = false;
    render(0);
    body.classList.add('sea-motion-playing');
    const tick = now => {
      if (stopped || !stage.isConnected) return;
      try {
        const t = Math.min(DURATION, Math.max(0, (now - started) / 1000) * DURATION / playbackSeconds);
        if (now - previous >= 1000 / 30 || t >= DURATION) { render(t); previous = now; }
        if (t < DURATION) raf = env.requestAnimationFrame(tick);
      } catch { body.classList.remove('sea-motion-playing'); }
    };
    raf = env.requestAnimationFrame(tick);
    return {
      finishBy: started + playbackSeconds * 1000,
      complete: () => {
        stopped = true; env.cancelAnimationFrame(raf);
        try { render(DURATION); } catch { body.classList.remove('sea-motion-playing'); }
      },
    };
  } catch {
    body.classList.remove('sea-motion-playing');
    return fallback;
  }
}
