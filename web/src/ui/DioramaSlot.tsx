import { useEffect, useState } from 'react';
import { colors } from './tokens';

interface Props {
  /** Cached three.js diorama for this world. Nothing is generated live. */
  dioramaUrl?: string;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

/**
 * Full-bleed backdrop for the world-forming screen. The diorama is a cached
 * artefact we host — it arrives 17 Oct. Until then, and whenever the viewer has
 * asked for less motion, this is just a gradient.
 */
export function DioramaSlot({ dioramaUrl }: Props) {
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);

  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReducedMotion(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const showIframe = Boolean(dioramaUrl) && !reducedMotion;

  return (
    <div style={styles.slot} aria-hidden="true">
      {showIframe ? (
        // No allow-same-origin: the diorama gets scripts and nothing else.
        <iframe
          src={dioramaUrl}
          title="diorama"
          sandbox="allow-scripts"
          loading="lazy"
          style={styles.frame}
        />
      ) : null}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  slot: {
    position: 'absolute',
    inset: 0,
    zIndex: 0,
    overflow: 'hidden',
    background: `linear-gradient(160deg, ${colors.ground} 0%, #0d0906 55%, #000000 100%)`,
  },
  frame: { width: '100%', height: '100%', border: 'none', display: 'block' },
};
