import { ArrowHeads, DISPLAY, MONO, Scroller } from './svgFrame.tsx';

export function SplitFigure() {
  return (
    <figure>
      <Scroller
        viewBox="0 0 940 300"
        label="Сравнение путей непрямого света: у них одна выборка в кадре, у нас три полноэкранных паса"
      >
        <ArrowHeads />
        <text x="20" y="26" fontFamily={MONO} fontSize="11.5" fontWeight="600" letterSpacing="1.5" fill="var(--them)">
          У НИХ — НЕПРЯМОЙ СВЕТ
        </text>
        <g fontFamily={DISPLAY} fontSize="13" fontWeight="600" textAnchor="middle" fill="currentColor">
          <rect x="20" y="44" width="188" height="46" rx="4" fill="var(--them-soft)" stroke="var(--them)" />
          <text x="114" y="66">Посчитано заранее</text>
          <text x="114" y="82" fontSize="11" fontFamily={MONO} opacity=".75">
            карта мира · объём · кэш
          </text>
          <rect x="252" y="44" width="150" height="46" rx="4" fill="var(--surface)" stroke="var(--line)" />
          <text x="327" y="72">Текстуры</text>
          <rect x="446" y="44" width="160" height="46" rx="4" fill="var(--them-soft)" stroke="var(--them)" strokeWidth="1.5" />
          <text x="526" y="72" fill="var(--them)">Одна выборка</text>
        </g>
        <g stroke="currentColor" strokeWidth="1.5" markerEnd="url(#ar)" opacity=".7">
          <line x1="208" y1="67" x2="246" y2="67" />
          <line x1="402" y1="67" x2="440" y2="67" />
        </g>
        <text x="622" y="72" fontFamily={MONO} fontSize="12.5" fill="currentColor" opacity=".7">
          в кадре — только правая коробка
        </text>
        <line x1="20" y1="128" x2="920" y2="128" stroke="currentColor" opacity=".2" />
        <text x="20" y="164" fontFamily={MONO} fontSize="11.5" fontWeight="600" letterSpacing="1.5" fill="var(--cost)">
          У НАС — НЕПРЯМОЙ СВЕТ
        </text>
        <g fontFamily={DISPLAY} fontSize="13" fontWeight="600" textAnchor="middle" fill="currentColor">
          <rect x="20" y="182" width="188" height="46" rx="4" fill="var(--bake-soft)" stroke="var(--bake)" />
          <text x="114" y="204">Прогрев: атлас</text>
          <text x="114" y="220" fontSize="11" fontFamily={MONO} opacity=".75">
            только то, что развернулось
          </text>
          <rect x="252" y="182" width="176" height="46" rx="4" fill="var(--cost-soft)" stroke="var(--cost)" strokeWidth="1.5" />
          <text x="340" y="204" fill="var(--cost)">Буфер GI</text>
          <text x="340" y="220" fontSize="11" fontFamily={MONO} fill="var(--cost)">
            2.3 мс
          </text>
          <rect x="452" y="182" width="176" height="46" rx="4" fill="var(--cost-soft)" stroke="var(--cost)" strokeWidth="1.5" />
          <text x="540" y="204" fill="var(--cost)">Поиск дыр</text>
          <text x="540" y="220" fontSize="11" fontFamily={MONO} fill="var(--cost)">
            7.4 мс
          </text>
          <rect x="652" y="182" width="176" height="46" rx="4" fill="var(--cost-soft)" stroke="var(--cost)" strokeWidth="1.5" />
          <text x="740" y="204" fill="var(--cost)">Резолв</text>
          <text x="740" y="220" fontSize="11" fontFamily={MONO} fill="var(--cost)">
            7.4 мс
          </text>
        </g>
        <g stroke="var(--cost)" strokeWidth="1.5" markerEnd="url(#arc)">
          <line x1="428" y1="205" x2="446" y2="205" />
          <line x1="628" y1="205" x2="646" y2="205" />
        </g>
        <line x1="208" y1="205" x2="246" y2="205" stroke="currentColor" strokeWidth="1.5" markerEnd="url(#ar)" opacity=".7" />
        <text x="20" y="262" fontFamily={MONO} fontSize="12.5" fill="var(--cost)" fontWeight="600">
          три полноэкранных паса в кадре, плюс интегратор 2.4 мс
        </text>
        <text x="20" y="282" fontFamily={MONO} fontSize="12" fill="currentColor" opacity=".65">
          всё это обслуживает статику, у которой негде хранить свет
        </text>
      </Scroller>
      <figcaption className="cap">
        Слева направо — путь непрямого света. У соседей в кадре остаётся одна выборка; у нас живут три полноэкранных
        паса и интегратор.
      </figcaption>
    </figure>
  );
}
