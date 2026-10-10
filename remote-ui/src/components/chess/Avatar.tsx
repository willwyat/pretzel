import { AVATARS, avatarSrc, EXPRESSIONS, type Expression } from "../../lib/chessAvatars";

/**
 * Pixel portrait: one frame of the avatar's strip, scaled with
 * `image-rendering: pixelated`. All expressions live in the one image, so a
 * change of face never waits on the network. `id` null draws an empty frame.
 */
export function Avatar({
  id,
  expression = "neutral",
  className = "",
}: {
  id: number | null;
  expression?: Expression;
  className?: string;
}) {
  const avatar = AVATARS.find((a) => a.id === id);
  if (!avatar) return <span className={`chess-avatar chess-avatar--empty ${className}`.trim()} aria-hidden />;
  const frame = EXPRESSIONS.indexOf(expression);
  return (
    <span
      className={`chess-avatar ${className}`.trim()}
      role="img"
      aria-label={`${avatar.name}, ${expression}`}
      style={{
        backgroundImage: `url(${avatarSrc(avatar.id)})`,
        backgroundPosition: `${(frame / (EXPRESSIONS.length - 1)) * 100}% 0`,
      }}
    />
  );
}
