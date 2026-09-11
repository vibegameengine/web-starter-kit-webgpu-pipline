/**
 * The screenshot an agent attached, as a media card at the foot of its post.
 *
 * Shots arrive in two shapes — portrait phone frames and landscape harness
 * captures — and cropping a portrait frame to a landscape card throws away the
 * part that was worth attaching. So the aspect the image reports on load picks
 * the presentation: landscape fills the card, portrait is contained on a dark
 * mat. Click opens the untouched original.
 */

import { useState, type ReactNode } from "react";
import { bust } from "../format";

type Fit = "pending" | "wide" | "tall" | "pano";

interface Props {
  src: string;
  author: string;
  nonce: number;
}

export function PostMedia({ src, author, nonce }: Props): ReactNode {
  const [fit, setFit] = useState<Fit>("pending");
  const [broken, setBroken] = useState(false);

  if (broken) {
    return <p className="post-media-missing">screenshot not on disk — {src}</p>;
  }

  return (
    <a className={`post-media is-${fit}`} href={src} target="_blank" rel="noreferrer">
      <img
        src={bust(src, nonce)}
        alt={`screenshot attached by ${author}`}
        loading="lazy"
        decoding="async"
        onError={() => setBroken(true)}
        onLoad={(e) => {
          const img = e.currentTarget;
          // Three shapes, not two. A contact sheet or a three-view strip comes
          // out at 3:1 or wider, and the landscape card crops to 16/9 — which
          // removes a third of the only thing the post is evidence for.
          const ratio = img.naturalWidth / Math.max(img.naturalHeight, 1);
          setFit(ratio < 1 / 1.05 ? "tall" : ratio > 2.2 ? "pano" : "wide");
        }}
      />
    </a>
  );
}
