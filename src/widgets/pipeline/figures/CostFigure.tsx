import { ArrowHeads, DISPLAY, MONO, Scroller } from './svgFrame.tsx';

export function CostFigure() {
  return (
    <figure>
      <Scroller
        viewBox="0 0 900 250"
        label="Кадр 33.1 мс, из них 24.5 — цепь сурфелов; с выключенной цепью 8.6 мс"
      >
        <ArrowHeads />
        <line x1="150" y1="196" x2="870" y2="196" stroke="currentColor" strokeWidth="1" opacity=".35" />
        <g fontFamily={MONO} fontSize="11.5" fill="currentColor" opacity=".55" textAnchor="middle">
          <line x1="150" y1="196" x2="150" y2="202" stroke="currentColor" />
          <text x="150" y="218">0</text>
          <line x1="355.7" y1="196" x2="355.7" y2="202" stroke="currentColor" />
          <text x="355.7" y="218">10</text>
          <line x1="561.4" y1="196" x2="561.4" y2="202" stroke="currentColor" />
          <text x="561.4" y="218">20</text>
          <line x1="767.1" y1="196" x2="767.1" y2="202" stroke="currentColor" />
          <text x="767.1" y="218">30</text>
          <text x="510" y="240" opacity=".8">миллисекунды на кадр</text>
        </g>
        <line x1="320.7" y1="34" x2="320.7" y2="196" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 4" opacity=".5" />
        <text x="325" y="30" fontFamily={MONO} fontSize="11.5" fill="currentColor" opacity=".7">
          8.3 мс — 120 fps
        </text>
        <text x="138" y="76" textAnchor="end" fontFamily={DISPLAY} fontSize="14" fontWeight="600" fill="currentColor">
          как сейчас
        </text>
        <rect x="150" y="52" width="681" height="38" fill="var(--us-soft)" stroke="var(--us)" />
        <rect x="150" y="52" width="504" height="38" fill="var(--cost-soft)" stroke="var(--cost)" />
        <text x="402" y="76" textAnchor="middle" fontFamily={MONO} fontSize="12.5" fontWeight="600" fill="var(--cost)">
          цепь сурфелов · 24.5
        </text>
        <text x="843" y="76" fontFamily={MONO} fontSize="13" fontWeight="600" fill="currentColor">
          33.1
        </text>
        <text x="138" y="146" textAnchor="end" fontFamily={DISPLAY} fontSize="14" fontWeight="600" fill="currentColor">
          цепь выключена
        </text>
        <rect x="150" y="122" width="177" height="38" fill="var(--us-soft)" stroke="var(--us)" />
        <text x="339" y="146" fontFamily={MONO} fontSize="13" fontWeight="600" fill="currentColor">
          8.6
        </text>
        <text x="410" y="146" fontFamily={MONO} fontSize="12" fill="currentColor" opacity=".6">
          — но вместе со светом
        </text>
      </Scroller>
      <figcaption className="cap">
        Замер отключением, а не профилировщиком: инструментация таймстемпами завышает те самые пасы, которые меряет.
        Нижний столбец — доказательство, что цена именно здесь, и одновременно демонстрация проблемы.
      </figcaption>
    </figure>
  );
}
