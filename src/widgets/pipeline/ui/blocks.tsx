import type { ReactNode } from 'react';

export function Part({
  id,
  kicker,
  title,
  subtitle,
  children,
}: {
  id: string;
  kicker: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section className="part" id={id}>
      <p className="part-k">{kicker}</p>
      <h2>{title}</h2>
      {subtitle ? <p className="subtitle">{subtitle}</p> : null}
      {children}
    </section>
  );
}

export function Stage({ k, title, children }: { k: string; title: string; children: ReactNode }) {
  return (
    <div className="stage">
      <span className="k">{k}</span>
      <span>
        <span className="t">{title}</span>
        {children}
      </span>
    </div>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <span className="d">{children}</span>;
}

export function Shots({ children }: { children: ReactNode }) {
  return <div className="shots">{children}</div>;
}

export function Shot({
  src,
  alt,
  width,
  children,
}: {
  src: string;
  alt: string;
  width?: number;
  children: ReactNode;
}) {
  return (
    <figure className="shot" style={width ? { width } : undefined}>
      <img src={src} alt={alt} loading="lazy" />
      <figcaption>{children}</figcaption>
    </figure>
  );
}

export function HeroShot({ src, alt, children }: { src: string; alt: string; children: ReactNode }) {
  return (
    <figure className="big">
      <img src={src} alt={alt} />
      <figcaption className="cap">{children}</figcaption>
    </figure>
  );
}

export function Pull({ tone, children }: { tone?: 'ok' | 'them'; children: ReactNode }) {
  return <p className={tone ? `pull ${tone}` : 'pull'}>{children}</p>;
}

export function Tag({ kind, children }: { kind: 'same' | 'gap' | 'diff' | 'na' | 'src'; children: ReactNode }) {
  return <span className={`tag ${kind}`}>{children}</span>;
}

export function TakeTable({ children }: { children: ReactNode }) {
  return (
    <table>
      <thead>
        <tr>
          <th style={{ width: '38%' }}>Приём</th>
          <th style={{ width: '14%' }}>Решение</th>
          <th>Почему</th>
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

export function Take({
  what,
  kind,
  verdict,
  children,
}: {
  what: ReactNode;
  kind: 'same' | 'gap' | 'diff';
  verdict: string;
  children: ReactNode;
}) {
  return (
    <tr>
      <td>{what}</td>
      <td>
        <Tag kind={kind}>{verdict}</Tag>
      </td>
      <td>{children}</td>
    </tr>
  );
}

export function Steps({ tone, children }: { tone?: 'bake'; children: ReactNode }) {
  return <ol className={tone ? `steps ${tone}` : 'steps'}>{children}</ol>;
}

export function Step({ k, title, children }: { k: string; title: string; children: ReactNode }) {
  return (
    <li>
      <span className="k">{k}</span>
      <span>
        <span className="t">{title}</span>
        <span className="d">{children}</span>
      </span>
    </li>
  );
}

export function Risks({ children }: { children: ReactNode }) {
  return <div className="risks">{children}</div>;
}

export function Risk({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <b>{title}. </b>
      <span>{children}</span>
    </div>
  );
}
