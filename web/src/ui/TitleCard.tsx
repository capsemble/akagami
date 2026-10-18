import { useState } from 'react';
import type { World } from '@chapter-quest/shared';
import { colors, fonts, radii, space } from './tokens';

interface Props {
  world: World | null;
  onStart: () => void;
}

type Open = 'none' | 'controls' | 'concepts';

/**
 * The moment between the build and the game.
 *
 * Until now the forming screen handed you straight into a room: no title, no
 * logline, nothing naming the thing that had just been made for you out of
 * your own chapter. The style plate — the first asset the art director paints,
 * and the one that fixes the look of everything after it — sat on disk and was
 * never shown to anyone.
 *
 * Everything on this card is read off the world itself. A world built with
 * `PAINT_ART=off`, or one whose image model was down, has no plate and gets the
 * gradient; nothing here invents a picture it was not given.
 */
export function TitleCard({ world, onStart }: Props) {
  const [open, setOpen] = useState<Open>('none');

  if (!world) {
    return (
      <main style={styles.page}>
        <p style={styles.opening}>opening…</p>
      </main>
    );
  }

  return (
    <main style={styles.page}>
      <div style={styles.hero} aria-hidden="true">
        {world.styleUrl ? (
          <img src={world.styleUrl} alt="" style={styles.heroImage} />
        ) : (
          <div style={styles.heroFallback} />
        )}
        <div style={styles.heroVeil} />
      </div>

      <section style={styles.card}>
        <p style={styles.eyebrow}>{world.artStyle || 'your chapter, as a world'}</p>
        <h1 style={styles.title}>{world.title}</h1>
        <p style={styles.logline}>{world.logline}</p>
        {world.villain ? <p style={styles.villain}>Up against — {world.villain}</p> : null}

        <div style={styles.menu}>
          <button type="button" onClick={onStart} style={styles.start}>
            ▶ Start adventure
          </button>
          <button
            type="button"
            onClick={() => setOpen(open === 'controls' ? 'none' : 'controls')}
            style={styles.menuItem}
          >
            How to play
          </button>
          <button
            type="button"
            onClick={() => setOpen(open === 'concepts' ? 'none' : 'concepts')}
            style={styles.menuItem}
          >
            What you will learn
          </button>
        </div>

        {open === 'controls' ? (
          <ul style={styles.panel}>
            <li style={styles.panelRow}>
              <span style={styles.key}>WASD</span> walk the room
            </li>
            <li style={styles.panelRow}>
              <span style={styles.key}>E</span> use whatever you are standing at
            </li>
            <li style={styles.panelRow}>
              <span style={styles.key}>F</span> let the run go
            </li>
            <li style={styles.panelRow}>
              <span style={styles.key}>R</span> put it back and try it differently
            </li>
            <li style={styles.panelRow}>
              <span style={styles.key}>T</span> the agent trace, if you want to see the build
            </li>
            <li style={styles.panelNote}>
              Each act opens when the one before it is beaten. Getting it wrong costs nothing — that
              is how you find the rule.
            </li>
          </ul>
        ) : null}

        {open === 'concepts' ? (
          <ol style={styles.panel}>
            {world.acts.map((act) => (
              <li key={act.id} style={styles.concept}>
                <span style={styles.conceptTitle}>{act.title}</span>
                <span style={styles.conceptGoal}>{act.goal}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </section>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    position: 'relative',
    minHeight: '100%',
    display: 'grid',
    placeItems: 'center',
    padding: space.lg,
    background: colors.ground,
    overflow: 'hidden',
  },
  opening: { color: `${colors.parchment}88` },
  hero: { position: 'absolute', inset: 0, zIndex: 0 },
  heroImage: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  heroFallback: {
    width: '100%',
    height: '100%',
    background: `linear-gradient(160deg, ${colors.ground} 0%, #0d0906 55%, #000000 100%)`,
  },
  // The plate is a painting, not a backdrop: it needs something over it before
  // a paragraph can sit on top and still be read.
  heroVeil: {
    position: 'absolute',
    inset: 0,
    background: 'radial-gradient(120% 90% at 50% 20%, #00000055 0%, #0b0806dd 55%, #0b0806f7 100%)',
  },
  card: {
    position: 'relative',
    zIndex: 1,
    width: 'min(680px, 100%)',
    display: 'flex',
    flexDirection: 'column',
    gap: space.sm,
    padding: space.xl,
    borderRadius: radii.panel,
    border: `1px solid ${colors.gold}44`,
    background: '#0b0806aa',
    backdropFilter: 'blur(3px)',
    animation: 'cq-rise 400ms ease-out both',
  },
  eyebrow: {
    margin: 0,
    fontSize: 12,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: `${colors.gold}aa`,
  },
  title: {
    margin: 0,
    fontFamily: fonts.header,
    fontSize: 48,
    lineHeight: 1.05,
    color: colors.gold,
  },
  logline: { margin: 0, fontSize: 15, lineHeight: 1.6, color: `${colors.parchment}dd` },
  villain: { margin: 0, fontFamily: fonts.header, fontSize: 14, color: `${colors.parchment}88` },
  menu: { display: 'flex', flexDirection: 'column', gap: space.xs, marginTop: space.sm },
  start: {
    padding: `${space.sm}px ${space.md}px`,
    borderRadius: radii.chip,
    border: 'none',
    background: colors.gold,
    color: colors.ground,
    fontFamily: fonts.header,
    fontSize: 18,
    textAlign: 'left',
  },
  menuItem: {
    padding: `${space.sm}px ${space.md}px`,
    borderRadius: radii.chip,
    border: `1px solid ${colors.parchment}22`,
    background: '#00000033',
    color: `${colors.parchment}cc`,
    textAlign: 'left',
  },
  panel: {
    listStyle: 'none',
    margin: `${space.xs}px 0 0`,
    padding: space.md,
    display: 'grid',
    gap: space.xs,
    borderRadius: radii.chip,
    border: `1px solid ${colors.gold}22`,
    background: '#00000044',
  },
  panelRow: { fontSize: 13.5, lineHeight: 1.6, color: `${colors.parchment}cc` },
  panelNote: {
    marginTop: space.xs,
    paddingTop: space.xs,
    borderTop: `1px solid ${colors.parchment}1a`,
    fontSize: 12.5,
    lineHeight: 1.5,
    color: `${colors.parchment}88`,
  },
  key: {
    display: 'inline-block',
    minWidth: 46,
    marginRight: space.sm,
    fontFamily: fonts.header,
    color: colors.gold,
  },
  concept: { display: 'flex', flexDirection: 'column', gap: 1 },
  conceptTitle: { fontFamily: fonts.header, fontSize: 15, color: colors.gold },
  conceptGoal: { fontSize: 12.5, lineHeight: 1.45, color: `${colors.parchment}aa` },
};
