'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Reward for saying the magic word: every report mentioning "sidewalk" pops an
 * emoji, and the third one onwards adds confetti.
 *
 * Utterances are the source rather than accepted reports so the reward lands as
 * soon as the words are heard, whether or not the server keeps the report. The
 * overlay is decorative and never awaits anything, so dictation and the map are
 * untouched by it.
 */

const MENTION = /sidewalk/i;
/** From the third mention on the emoji stays the trophy and confetti fires. */
const CONFETTI_FROM = 3;
const POP_MS = 1800;
const CONFETTI_COLORS: readonly [string, ...string[]] = [
  '#38bdf8',
  '#f472b6',
  '#facc15',
  '#4ade80',
  '#c084fc',
];
const CONFETTI_PARTICLES = 110;

interface MentionSource {
  id: string;
  transcript: string;
}

interface Pop {
  id: string;
  emoji: string;
  /** Horizontal placement in percent so simultaneous pops do not overlap. */
  left: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  spin: number;
  angle: number;
  color: string;
  life: number;
}

function emojiFor(count: number): string {
  if (count === 1) return '👍';
  if (count === 2) return '❤️';
  return '🏆';
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function spawnParticles(width: number, height: number): Particle[] {
  return Array.from({ length: CONFETTI_PARTICLES }, () => {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI;
    const speed = 6 + Math.random() * 9;
    return {
      x: width / 2 + (Math.random() - 0.5) * width * 0.5,
      y: height * 0.55 + (Math.random() - 0.5) * height * 0.1,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      spin: (Math.random() - 0.5) * 0.3,
      angle: Math.random() * Math.PI,
      color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)] ?? CONFETTI_COLORS[0],
      life: 1,
    };
  });
}

export function MilestoneCelebration({ utterances }: { utterances: MentionSource[] }) {
  const [pops, setPops] = useState<Pop[]>([]);
  const seenRef = useRef<Set<string>>(new Set());
  const countRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const particlesRef = useRef<Particle[]>([]);
  const frameRef = useRef<number | null>(null);
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  /** Draws until every particle has faded, then releases the frame loop. */
  const runConfetti = useCallback(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    particlesRef.current = [...particlesRef.current, ...spawnParticles(canvas.width, canvas.height)];
    if (frameRef.current != null) return;

    const draw = () => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      particlesRef.current = particlesRef.current.filter((particle) => {
        particle.x += particle.vx;
        particle.y += particle.vy;
        particle.vy += 0.35;
        particle.vx *= 0.99;
        particle.angle += particle.spin;
        particle.life -= 0.012;
        if (particle.life <= 0 || particle.y > canvas.height + 20) return false;

        context.save();
        context.globalAlpha = Math.max(particle.life, 0);
        context.translate(particle.x, particle.y);
        context.rotate(particle.angle);
        context.fillStyle = particle.color;
        context.fillRect(-4, -7, 8, 14);
        context.restore();
        return true;
      });

      if (particlesRef.current.length) {
        frameRef.current = requestAnimationFrame(draw);
        return;
      }
      frameRef.current = null;
      context.clearRect(0, 0, canvas.width, canvas.height);
    };
    frameRef.current = requestAnimationFrame(draw);
  }, []);

  useEffect(() => {
    // Utterances arrive newest first and the list is capped, so new ones are
    // recognised by id and replayed oldest first to count in spoken order.
    const fresh = utterances.filter((utterance) => !seenRef.current.has(utterance.id));
    if (!fresh.length) return;
    fresh.forEach((utterance) => seenRef.current.add(utterance.id));

    const mentions = fresh.filter((utterance) => MENTION.test(utterance.transcript)).reverse();
    if (!mentions.length) return;

    const reduced = prefersReducedMotion();
    const next = mentions.map((utterance, index) => {
      countRef.current += 1;
      if (countRef.current >= CONFETTI_FROM && !reduced) runConfetti();
      return {
        id: utterance.id,
        emoji: emojiFor(countRef.current),
        left: 50 + (index - (mentions.length - 1) / 2) * 14,
      };
    });

    setPops((current) => [...current, ...next]);
    const timer = setTimeout(() => {
      timersRef.current.delete(timer);
      setPops((current) => current.filter((pop) => !next.some((pop2) => pop2.id === pop.id)));
    }, POP_MS);
    timersRef.current.add(timer);
  }, [runConfetti, utterances]);

  useEffect(
    () => () => {
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      timersRef.current.forEach(clearTimeout);
      timersRef.current.clear();
    },
    [],
  );

  return (
    <div className="milestone-layer" aria-hidden="true">
      <canvas className="milestone-confetti" ref={canvasRef} />
      {pops.map((pop) => (
        <span key={pop.id} className="milestone-emoji" style={{ left: `${pop.left}%` }}>
          {pop.emoji}
        </span>
      ))}
    </div>
  );
}
