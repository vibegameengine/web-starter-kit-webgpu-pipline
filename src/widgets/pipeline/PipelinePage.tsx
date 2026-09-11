import './pipeline.css';

import { CostFigure } from './figures/CostFigure.tsx';
import { AlanWakeSection } from './sections/AlanWakeSection.tsx';
import { CompareSection } from './sections/CompareSection.tsx';
import { CyberpunkSection } from './sections/CyberpunkSection.tsx';
import { DesignSection } from './sections/DesignSection.tsx';
import { LumenSection } from './sections/LumenSection.tsx';
import { Rdr2Section } from './sections/Rdr2Section.tsx';
import { SourcesFooter } from './sections/SourcesFooter.tsx';

export function PipelinePage() {
  return (
    <div className="pipeline-doc" data-testid="pipeline-doc">
      <header>
        <p className="eyebrow">
          AAA-рендеринг для веба · RDR2 · Cyberpunk 2077 · Alan Wake 2 · Unreal Lumen · финальный дизайн
        </p>
        <h1>RDR2 как база, красивости из соседей</h1>
        <p className="standfirst">
          Цель — AAA-рендеринг для веба, движок общего назначения. Пляж это стенд, а не продукт. Четыре движка, четыре
          разных хранилища непрямого света, и ни один не решает его попиксельно в кадре. У нас решает — и это стоит{' '}
          <b>24.5 мс из 33.1</b> на 4K.
        </p>
      </header>

      <CostFigure />

      <Rdr2Section />
      <CyberpunkSection />
      <AlanWakeSection />
      <LumenSection />
      <CompareSection />
      <DesignSection />

      <SourcesFooter />
    </div>
  );
}
