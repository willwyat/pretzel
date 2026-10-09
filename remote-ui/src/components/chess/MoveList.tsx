import { useEffect, useRef } from "react";

/**
 * Two-column SAN list (White | Black). `current` highlights a ply (1-based) and
 * `onPick` makes rows clickable, for replay.
 */
export function MoveList({
  sans,
  current,
  onPick,
}: {
  sans: string[];
  current?: number;
  onPick?: (ply: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const on = el.querySelector<HTMLElement>(".win-mv--on");
    if (on) on.scrollIntoView({ block: "nearest" });
    else el.scrollTop = el.scrollHeight;
  }, [sans.length, current]);

  const rows: number[] = [];
  for (let i = 0; i < sans.length; i += 2) rows.push(i);

  const cell = (ply: number) => {
    const san = sans[ply - 1];
    if (!san) return <td />;
    const cls = `win-mv${current === ply ? " win-mv--on" : ""}`;
    return (
      <td>
        {onPick ? (
          <button type="button" className={cls} onClick={() => onPick(ply)}>
            {san}
          </button>
        ) : (
          <span className={cls}>{san}</span>
        )}
      </td>
    );
  };

  return (
    <div className="win-sunken win-moves" ref={box} aria-label="Moves">
      {sans.length === 0 ? (
        <p className="win-hint win-moves-empty">No moves yet.</p>
      ) : (
        <table className="win-movetable">
          <tbody>
            {rows.map((i) => (
              <tr key={i}>
                <th scope="row">{i / 2 + 1}.</th>
                {cell(i + 1)}
                {cell(i + 2)}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
