export type Tag = 'same' | 'gap' | 'diff' | 'na';

export type Shot = { src: string; alt: string; cap: string; w?: number };

export type Stage = { k: string; t: string; d: string; shots?: Shot[] };

export type Pull = { tone: 'ok' | 'them' | 'cost'; text: string };

export type TakeRow = [string, Tag, string, string];

export type Reference = {
  id: string;
  k: string;
  title: string;
  subtitle: string;
  intro?: string[];
  heroShot?: Shot;
  stages: Stage[];
  pull?: Pull;
  outro?: string[];
  take?: TakeRow[];
};

export type CompareRow = [string, string, Tag, string, string, boolean?];

export type Block =
  | { type: 'pull'; tone: Pull['tone']; text: string }
  | { type: 'h3'; text: string }
  | { type: 'p'; text: string };

export type Compare = { k: string; title: string; intro: string[]; rows: CompareRow[]; after: Block[] };

export type BudgetRow = [string, string, string];

export type Step = [string, string, string];

export type Design = {
  k: string;
  title: string;
  intro: string[];
  bake: Step[];
  frame: Step[];
  borrowed: [string, string, string][];
  risks: [string, string][];
  steps: Step[];
};

export type Source = [string, string];

export type Hero = { eyebrow: string; title: string; standfirst: string };
