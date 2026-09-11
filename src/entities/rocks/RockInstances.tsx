import { MultiInstances, type PrefabInstance, type PrefabPart } from '../../shared/fiber/index.ts';

export interface RockBatch { id: string; parts: PrefabPart[]; instances: PrefabInstance[] }

export function RockInstances({ batches }: { batches: RockBatch[] }) {
  return <group name="village-shore-rocks">{batches.map(batch => <MultiInstances key={batch.id} name={batch.id} parts={batch.parts} instances={batch.instances} />)}</group>;
}
