// Tiny moving pictures of the three work styles, for the builder's style cards: packets fan out at
// once (parallel), hop member to member (step by step), or flow into a magnifier Dot (review).
// Decorative; the card's text says the same. Static under reduced motion (see teams.css).
import type { CSSProperties } from 'react';
import type { TeamStyle } from '../../shared/teams';
import type { DotColor } from '../../shared/types';

const packet = (dx: number, dy: number, delay = 0): CSSProperties =>
  ({
    '--dx': `${dx}px`,
    '--dy': `${dy}px`,
    animationDelay: `${delay}s`,
  }) as CSSProperties;

function Node({
  x,
  y,
  color,
  r = 6,
}: {
  x: number;
  y: number;
  color: DotColor;
  r?: number;
}) {
  return (
    <g className="sd-node">
      <circle cx={x} cy={y} r={r} fill={`var(--dot-${color}-base)`} />
      <circle cx={x - r / 3} cy={y - r / 4} r={r / 5} fill="#1c1f2e" />
      <circle cx={x + r / 3} cy={y - r / 4} r={r / 5} fill="#1c1f2e" />
    </g>
  );
}

export function StyleDiagram({
  style,
  color = 'coral',
}: {
  style: TeamStyle;
  /** The packets take the team's colour. */
  color?: DotColor;
}) {
  const fill = `var(--dot-${color}-base)`;
  if (style === 'parallel')
    return (
      <svg
        className="style-diagram sd-parallel"
        viewBox="0 0 120 48"
        aria-hidden
      >
        <path
          className="sd-wire"
          d="M22 24 L98 9 M22 24 L98 24 M22 24 L98 39"
        />
        {[-15, 0, 15].map((dy) => (
          <circle
            key={dy}
            className="sd-packet sd-fan"
            cx="22"
            cy="24"
            r="3"
            fill={fill}
            style={packet(76, dy)}
          />
        ))}
        <Node x={16} y={24} color={color} r={8} />
        <Node x={102} y={9} color="mint" />
        <Node x={102} y={24} color="sky" />
        <Node x={102} y={39} color="lilac" />
      </svg>
    );
  if (style === 'sequential')
    return (
      <svg
        className="style-diagram sd-sequential"
        viewBox="0 0 120 48"
        aria-hidden
      >
        <path className="sd-wire" d="M14 24 H106" />
        <circle
          className="sd-packet sd-hop"
          cx="14"
          cy="24"
          r="3"
          fill={fill}
        />
        <Node x={14} y={24} color={color} r={7} />
        <Node x={45} y={24} color="mint" />
        <Node x={76} y={24} color="sky" />
        <Node x={106} y={24} color="lilac" />
      </svg>
    );
  return (
    <svg className="style-diagram sd-review" viewBox="0 0 120 48" aria-hidden>
      <path className="sd-wire" d="M18 9 L88 24 M18 24 L88 24 M18 39 L88 24" />
      {[
        [15, 0.0],
        [0, 0.25],
        [-15, 0.5],
      ].map(([dy, delay]) => (
        <circle
          key={dy}
          className="sd-packet sd-gather"
          cx="18"
          cy={24 - dy!}
          r="2.6"
          fill={fill}
          style={packet(70, dy!, delay)}
        />
      ))}
      <Node x={14} y={9} color="mint" />
      <Node x={14} y={24} color="sky" />
      <Node x={14} y={39} color="lilac" />
      <Node x={96} y={24} color={color} r={9} />
      <g className="sd-loupe">
        <circle
          cx="104"
          cy="16"
          r="5"
          fill="#ffffffcc"
          stroke="#1c1f2e"
          strokeWidth="1.6"
        />
        <path d="M107.5 19.5 L112 24" stroke="#1c1f2e" strokeWidth="2" />
      </g>
    </svg>
  );
}
