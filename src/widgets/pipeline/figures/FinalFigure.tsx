import { ArrowHeads, DISPLAY, MONO, Scroller } from './svgFrame.tsx';

function BakeRow() {
  return (
    <>
      <text x="24" y="34" fontFamily={MONO} fontSize="11.5" fontWeight="600" letterSpacing="1.6" fill="var(--bake)">
        ПРОГРЕВ · ОДИН РАЗ, ДАЛЬШЕ С ДИСКА
      </text>
      <g fontFamily={DISPLAY} fontSize="13.5" fontWeight="600" fill="currentColor" textAnchor="middle">
        <rect x="24" y="50" width="150" height="52" rx="4" fill="var(--surface)" stroke="var(--line)" />
        <text x="99" y="81">BVH сцены</text>
        <rect x="204" y="50" width="150" height="52" rx="4" fill="var(--surface)" stroke="var(--line)" />
        <text x="279" y="81">Развёртка UV</text>
        <rect x="384" y="50" width="182" height="52" rx="4" fill="var(--bake-soft)" stroke="var(--bake)" strokeWidth="1.5" />
        <text x="475" y="81" fill="var(--bake)">Surfel-радиосити</text>
        <rect x="596" y="50" width="150" height="52" rx="4" fill="var(--bake-soft)" stroke="var(--bake)" />
        <text x="671" y="74" fill="var(--bake)">Атлас</text>
        <text x="671" y="91" fill="var(--bake)">+ сетка проб</text>
        <rect x="776" y="50" width="150" height="52" rx="4" fill="var(--surface)" stroke="var(--line)" />
        <text x="851" y="81">Кэш на диск</text>
      </g>
      <g stroke="currentColor" strokeWidth="1.5" markerEnd="url(#ar)" opacity=".75">
        <line x1="174" y1="76" x2="198" y2="76" />
        <line x1="354" y1="76" x2="378" y2="76" />
        <line x1="566" y1="76" x2="590" y2="76" />
        <line x1="746" y1="76" x2="770" y2="76" />
      </g>
      <path
        d="M926 76 L952 76 L952 128 L24 128 L24 108"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray="5 4"
        opacity=".5"
        markerEnd="url(#ar)"
      />
      <text x="488" y="123" textAnchor="middle" fontFamily={MONO} fontSize="11" fill="currentColor" opacity=".6">
        следующий запуск — прогрев пропущен
      </text>
    </>
  );
}

function FrameRow() {
  return (
    <>
      <text x="24" y="234" fontFamily={MONO} fontSize="11.5" fontWeight="600" letterSpacing="1.6" fill="var(--us)">
        КАДР · КАЖДЫЙ РАЗ
      </text>
      <g fontFamily={DISPLAY} fontSize="13" fontWeight="600" fill="currentColor" textAnchor="middle">
        <rect x="24" y="246" width="118" height="50" rx="4" fill="var(--surface)" stroke="var(--line)" />
        <text x="83" y="276">G-буфер</text>
        <rect x="156" y="246" width="106" height="50" rx="4" fill="var(--surface)" stroke="var(--line)" />
        <text x="209" y="276">Тени</text>
        <rect x="276" y="246" width="118" height="50" rx="4" fill="var(--surface)" stroke="var(--line)" />
        <text x="335" y="276">Кубмапа</text>
        <rect x="408" y="246" width="152" height="50" rx="4" fill="var(--us-soft)" stroke="var(--us)" strokeWidth="1.5" />
        <text x="484" y="276" fill="var(--us)">Свет</text>
        <rect x="574" y="246" width="118" height="50" rx="4" fill="var(--surface)" stroke="var(--line)" />
        <text x="633" y="276">Отражения</text>
        <rect x="706" y="246" width="106" height="50" rx="4" fill="var(--surface)" stroke="var(--line)" />
        <text x="759" y="276">Композит</text>
        <rect x="826" y="246" width="100" height="50" rx="4" fill="var(--surface)" stroke="var(--line)" />
        <text x="876" y="276">TAA</text>
      </g>
      <g stroke="currentColor" strokeWidth="1.5" markerEnd="url(#ar)" opacity=".75">
        <line x1="142" y1="271" x2="150" y2="271" />
        <line x1="262" y1="271" x2="270" y2="271" />
        <line x1="394" y1="271" x2="402" y2="271" />
        <line x1="560" y1="271" x2="568" y2="271" />
        <line x1="692" y1="271" x2="700" y2="271" />
        <line x1="812" y1="271" x2="820" y2="271" />
      </g>
    </>
  );
}

export function FinalFigure() {
  return (
    <figure>
      <Scroller
        viewBox="0 0 980 430"
        label="Итоговая схема: прогрев пишет атлас и сетку проб, кадр читает их одной выборкой"
      >
        <ArrowHeads />
        <BakeRow />
        <path d="M671 102 L671 168 L560 168 L560 246" fill="none" stroke="var(--bake)" strokeWidth="2" markerEnd="url(#arb)" />
        <text x="686" y="150" fontFamily={MONO} fontSize="11.5" fontWeight="600" fill="var(--bake)">
          одна выборка на пиксель
        </text>
        <FrameRow />
        <rect x="24" y="330" width="536" height="58" rx="4" fill="var(--cost-soft)" stroke="var(--cost)" strokeDasharray="6 4" />
        <text x="44" y="354" fontFamily={MONO} fontSize="11.5" fontWeight="600" letterSpacing="1.4" fill="var(--cost)">
          ИСЧЕЗАЮТ ИЗ КАДРА
        </text>
        <text x="44" y="374" fontFamily={MONO} fontSize="12.5" fill="var(--cost)">
          Find Missing · Integrate · GI Resolve · буфер GI
        </text>
        <text x="584" y="358" fontFamily={DISPLAY} fontSize="14" fontWeight="600" fill="currentColor">
          Их работу забрал прогрев,
        </text>
        <text x="584" y="378" fontFamily={DISPLAY} fontSize="14" fontWeight="600" fill="currentColor">
          результат лежит в двух текстурах.
        </text>
      </Scroller>
      <figcaption className="cap">
        Единственная связь между дорожками — выборка внутри прохода освещения. Четыре паса, составляющие сегодня около
        19.5 мс по долям и 24.5 мс по замеру отключением, из кадра уходят.
      </figcaption>
    </figure>
  );
}
