/** The post text, with bare URLs turned into real links. */

import { useMemo, type ReactNode } from "react";
import { linkify } from "../linkify";

export function PostBody({ text }: { text: string }): ReactNode {
  const segments = useMemo(() => linkify(text), [text]);
  return (
    <p className="post-body">
      {segments.map((seg, i) =>
        seg.kind === "link" ? (
          <a key={i} href={seg.href} target="_blank" rel="noreferrer">
            {seg.label}
          </a>
        ) : (
          seg.value
        ),
      )}
    </p>
  );
}
