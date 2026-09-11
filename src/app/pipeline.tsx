import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { PipelinePage } from '../widgets/pipeline/index.ts';

document.title = 'RDR2 как база, красивости из соседей';

const mount = document.createElement('div');
mount.id = 'pipeline-root';
document.body.append(mount);

createRoot(mount).render(
  <StrictMode>
    <PipelinePage />
  </StrictMode>,
);
