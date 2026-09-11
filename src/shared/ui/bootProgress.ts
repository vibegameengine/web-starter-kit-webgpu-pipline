export type BootProgressListener = (label: string) => void;

const openStages: string[] = [];
let listener: BootProgressListener | null = null;

export function onBootProgress(next: BootProgressListener | null): void {
  listener = next;
}

function announce(): void {
  if (openStages.length > 0) listener?.(openStages[openStages.length - 1]);
}

function nextPaint(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') return Promise.resolve();
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

export async function bootStage<T>(label: string, work: () => T | Promise<T>): Promise<T> {
  openStages.push(label);
  announce();
  await nextPaint();
  try {
    return await work();
  } finally {
    openStages.pop();
    announce();
  }
}

export function bootNote(label: string): void {
  listener?.(label);
}
