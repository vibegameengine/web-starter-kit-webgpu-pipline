import type { Entry } from './catalog';
import { DOCS, FLAGS, LABS, SCENES } from './catalog';
import './home.css';

function Card({ entry }: { entry: Entry }) {
  return (
    <article className="home-card">
      <a className={`home-art ${entry.art}`} href={entry.href} aria-label={entry.title}>
        {entry.preview && <img src={entry.preview} alt="Текущий вид сцены" loading="lazy" />}
      </a>
      <div className="home-body">
        <h3>{entry.title}</h3>
        <p className="home-desc">{entry.description}</p>
        <div className="home-chips">
          <a className="home-chip home-chip-primary" href={entry.href}>
            {entry.open}
          </a>
          {entry.chips.map((chip) => (
            <a className="home-chip" key={chip.href} href={chip.href}>
              {chip.label}
            </a>
          ))}
        </div>
      </div>
    </article>
  );
}

function Section({ id, title, note, entries }: { id: string; title: string; note: string; entries: Entry[] }) {
  return (
    <section className="home-section" id={id}>
      <div className="home-section-head">
        <h2>{title}</h2>
        <span className="home-section-note">{note}</span>
      </div>
      <div className="home-grid">
        {entries.map((entry) => (
          <Card entry={entry} key={entry.href} />
        ))}
      </div>
    </section>
  );
}

export function Home() {
  return (
    <div className="home">
      <nav className="home-nav">
        <div className="home-nav-inner">
          <a className="home-brand" href="#top">
            Elderwood
          </a>
          <a href="#scenes">Сцены</a>
          <a href="#labs">Лаборатории</a>
          <a href="#docs">Документы</a>
          <span className="home-nav-spacer" />
          <a href="/?scene=beach">Запустить</a>
        </div>
      </nav>

      <header className="home-header" id="top">
        <h1>
          Свет, вода и листва.
          <br />В браузере.
        </h1>
        <p className="home-lede">
          WebGPU-конвейер на Three r182: запечённый лайтмап-атлас, объём зондов, мягкое солнце, трассированные
          отражения, TAA.
        </p>
        <div className="home-cta">
          <a href="/?scene=beach">Открыть пляж</a>
          <a href="/?scene=midsee-village">Деревня Мидси — в работе</a>
          <a href="/labs/water/">Лаборатория воды</a>
          <a href="/dashboard.html">Лента агентов</a>
          <a href="/pipeline">Как это устроено</a>
        </div>
      </header>

      <Section id="scenes" title="Сцены" note="одна страница, параметр ?scene=" entries={SCENES} />
      <Section id="labs" title="Лаборатории" note="отдельные страницы со своим циклом кадра" entries={LABS} />
      <Section id="docs" title="Документы" note="чертежи конвейера" entries={DOCS} />

      <section className="home-section" id="flags">
        <div className="home-section-head">
          <h2>Ключи в адресе</h2>
          <span className="home-section-note">работают в любой сцене</span>
        </div>
        <div className="home-flags">
          {FLAGS.map((flag) => (
            <div className="home-flag" key={flag.key}>
              <code>{flag.key}</code>
              <p>{flag.effect}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="home-footer">
        <span>Three.js r182 · WebGPU · TSL/WGSL · React 19</span>
        <span>
          <code>npm run dev</code> → <code>127.0.0.1:5188</code>
        </span>
      </footer>
    </div>
  );
}
