'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  VOICE_ERROR_MESSAGES,
  decideVoiceRestart,
  inputLevel,
  isTerminalVoiceError,
  parseVoiceReport,
  voiceErrorKind,
  type ParsedVoiceReport,
} from '@sidewalk/core';

/**
 * Ambient voice dictation with the Web Speech API.
 *
 * `SpeechRecognition` is prefixed in Chromium (`webkitSpeechRecognition`) and is
 * not enabled in Firefox, so support is detected at runtime and the caller falls
 * back to typing. In Chrome the audio is streamed to Google's recognition service
 * — that is a privacy fact, not an implementation detail, so dictation is strictly
 * opt-in and can be stopped at any time.
 *
 * `continuous` keeps the recogniser open for a whole run and `interimResults`
 * gives the live caption; only final results are parsed into reports.
 *
 * Microphone access is taken explicitly with `getUserMedia` before the recogniser
 * starts. Recognition would raise its own prompt, but then a refusal surfaces as
 * a silent recogniser, and the same stream drives the input-level meter — which
 * is the only way for a runner to tell "nobody is listening" apart from "the wind
 * is louder than I am".
 */

// Minimal structural types: TS's DOM lib does not ship SpeechRecognition.
interface SpeechRecognitionAlternativeLike {
  transcript: string;
  confidence: number;
}
interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  0?: SpeechRecognitionAlternativeLike;
  item(index: number): SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: {
    length: number;
    item(index: number): SpeechRecognitionResultLike;
  };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export type MicrophoneState = 'unknown' | 'granted' | 'denied' | 'unavailable';

export interface VoiceUtterance {
  id: string;
  transcript: string;
  recognitionConfidence: number | null;
  parsed: ParsedVoiceReport | null;
  at: number;
}

export interface UseVoiceReporterOptions {
  lang?: string;
  /** Called for every final utterance that parsed into a report. */
  onReport: (utterance: VoiceUtterance & { parsed: ParsedVoiceReport }) => void;
}

/** How often the level meter is allowed to re-render. */
const LEVEL_INTERVAL_MS = 120;

export function useVoiceReporter({ lang = 'en-US', onReport }: UseVoiceReporterOptions) {
  const [supported, setSupported] = useState(false);
  const [micState, setMicState] = useState<MicrophoneState>('unknown');
  const [listening, setListening] = useState(false);
  const [starting, setStarting] = useState(false);
  const [interim, setInterim] = useState('');
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [utterances, setUtterances] = useState<VoiceUtterance[]>([]);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const wantListeningRef = useRef(false);
  const failuresRef = useRef(0);
  const sessionStartedAtRef = useRef(0);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Bumped by anything that ends a session. `getUserMedia` can resolve after the
   * run has stopped or the component has unmounted, and that late stream would
   * otherwise be kept and recognised from.
   */
  const generationRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const frameRef = useRef<number | null>(null);
  const onReportRef = useRef(onReport);
  onReportRef.current = onReport;

  useEffect(() => {
    setSupported(recognitionCtor() != null);
  }, []);

  /** Follows a permission the user changed in browser settings mid-run. */
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return;

    let status: PermissionStatus | null = null;
    let cancelled = false;
    const onChange = () => {
      if (!status) return;
      if (status.state === 'granted') setMicState('granted');
      if (status.state === 'denied') setMicState('denied');
      if (status.state === 'prompt') setMicState('unknown');
    };

    void navigator.permissions
      // `microphone` is not in every browser's PermissionName union, and a
      // browser that does not know the name rejects the query.
      .query({ name: 'microphone' as PermissionName })
      .then((result) => {
        if (cancelled) return;
        status = result;
        onChange();
        result.addEventListener('change', onChange);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      status?.removeEventListener('change', onChange);
    };
  }, []);

  const releaseMic = useCallback(() => {
    if (frameRef.current != null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    void audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    // Stopping the tracks is what clears the browser's recording indicator; a
    // held stream tells the runner they are still being recorded.
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setLevel(0);
  }, []);

  /** Drives the level meter from the same stream the recogniser is hearing. */
  const startMeter = useCallback((stream: MediaStream) => {
    const Ctor =
      typeof window === 'undefined'
        ? undefined
        : (window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext);
    if (!Ctor) return;

    const context = new Ctor();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
    audioContextRef.current = context;

    const samples = new Float32Array(analyser.fftSize);
    let lastAt = 0;
    const tick = (now: number) => {
      frameRef.current = requestAnimationFrame(tick);
      if (now - lastAt < LEVEL_INTERVAL_MS) return;
      lastAt = now;
      analyser.getFloatTimeDomainData(samples);
      setLevel(inputLevel(samples));
    };
    frameRef.current = requestAnimationFrame(tick);
  }, []);

  const handleFinal = useCallback((transcript: string, confidence: number | null) => {
    const text = transcript.trim();
    if (!text) return;
    const parsed = parseVoiceReport(text, confidence);
    const utterance: VoiceUtterance = {
      id: crypto.randomUUID(),
      transcript: text,
      recognitionConfidence: confidence,
      parsed,
      at: Date.now(),
    };
    setUtterances((current) => [utterance, ...current].slice(0, 25));
    if (parsed) onReportRef.current({ ...utterance, parsed });
  }, []);

  const stopRecognition = useCallback(() => {
    wantListeningRef.current = false;
    failuresRef.current = 0;
    generationRef.current += 1;
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    setInterim('');
    setListening(false);
    setStarting(false);
    recognitionRef.current?.abort();
    recognitionRef.current = null;
    releaseMic();
  }, [releaseMic]);

  /** Builds and starts a recogniser; the mic stream must already be held. */
  const spawnRecognition = useCallback((): boolean => {
    const Ctor = recognitionCtor();
    if (!Ctor) {
      setError('This browser does not support the Web Speech API.');
      return false;
    }

    // A second start without a stop would leave the previous recogniser
    // running alongside the new one.
    if (recognitionRef.current) {
      recognitionRef.current.abort();
      recognitionRef.current = null;
    }

    const recognition = new Ctor();
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      let live = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results.item(i);
        const alternative = result.item(0);
        if (result.isFinal) {
          handleFinal(alternative.transcript, alternative.confidence ?? null);
        } else {
          live += alternative.transcript;
        }
      }
      setInterim(live);
    };

    recognition.onerror = (event) => {
      const kind = voiceErrorKind(event.error);
      if (isTerminalVoiceError(kind)) {
        if (kind === 'not-allowed' || kind === 'service-not-allowed') setMicState('denied');
        setError(VOICE_ERROR_MESSAGES[kind]);
        stopRecognition();
        return;
      }
      // Silence and an aborted session are the run's normal state, not errors.
      if (kind === 'no-speech' || kind === 'aborted') return;
      setError(kind === 'unknown' ? event.message || VOICE_ERROR_MESSAGES.unknown : VOICE_ERROR_MESSAGES[kind]);
    };

    // Chrome ends the session after a pause even with continuous = true.
    recognition.onend = () => {
      // `abort()` ends asynchronously, so a replaced recogniser must not restart
      // itself off the flag that now belongs to its replacement.
      if (recognitionRef.current !== recognition) return;
      setInterim('');

      const decision = decideVoiceRestart({
        wantListening: wantListeningRef.current,
        sessionMs: Date.now() - sessionStartedAtRef.current,
        consecutiveFailures: failuresRef.current,
      });
      failuresRef.current = decision.failures;

      if (!decision.restart) {
        if (decision.message) setError(decision.message);
        stopRecognition();
        return;
      }

      const resume = () => {
        restartTimerRef.current = null;
        if (recognitionRef.current !== recognition || !wantListeningRef.current) return;
        try {
          sessionStartedAtRef.current = Date.now();
          recognition.start();
        } catch {
          stopRecognition();
        }
      };
      if (decision.delayMs === 0) resume();
      else restartTimerRef.current = setTimeout(resume, decision.delayMs);
    };

    recognitionRef.current = recognition;
    try {
      sessionStartedAtRef.current = Date.now();
      recognition.start();
      return true;
    } catch (cause) {
      recognitionRef.current = null;
      setError(cause instanceof Error ? cause.message : 'Could not start speech recognition.');
      return false;
    }
  }, [handleFinal, lang, stopRecognition]);

  /**
   * Takes the microphone, then starts recognising. Must be called from a user
   * gesture so the browser attributes the prompt to the tap.
   */
  const startRecognition = useCallback(async (): Promise<boolean> => {
    if (wantListeningRef.current) return true;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setMicState('unavailable');
      setError('This browser cannot record audio (a secure origin is required) — type reports instead.');
      return false;
    }

    setStarting(true);
    setError(null);
    const generation = generationRef.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Street noise and wind, not a studio: let the browser's own
          // processing clean up the signal before it is recognised.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (generation !== generationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }
      streamRef.current = stream;
      setMicState('granted');
      startMeter(stream);

      wantListeningRef.current = true;
      failuresRef.current = 0;
      if (!spawnRecognition()) {
        stopRecognition();
        return false;
      }
      setListening(true);
      return true;
    } catch (cause) {
      const name = cause instanceof Error ? cause.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setMicState('denied');
        setError(VOICE_ERROR_MESSAGES['not-allowed']);
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        setMicState('unavailable');
        setError(VOICE_ERROR_MESSAGES['audio-capture']);
      } else {
        setError(cause instanceof Error ? cause.message : 'Could not open the microphone.');
      }
      releaseMic();
      wantListeningRef.current = false;
      return false;
    } finally {
      setStarting(false);
    }
  }, [releaseMic, spawnRecognition, startMeter, stopRecognition]);

  /**
   * Drops the phrase in progress without ending the session — for a misspoken
   * report, where waiting for the recogniser to finalise nonsense and then
   * ignoring the result is the worse experience.
   */
  const cancelPhrase = useCallback(() => {
    if (!wantListeningRef.current) return;
    setInterim('');
    setError(null);
    // Aborting drops the buffered audio; `onend` then restarts the session
    // because the user still wants to listen.
    recognitionRef.current?.abort();
    recognitionRef.current = null;
    failuresRef.current = 0;
    spawnRecognition();
  }, [spawnRecognition]);

  /** Lets the user re-ask after fixing the permission in browser settings. */
  const retryMic = useCallback(() => {
    setMicState('unknown');
    setError(null);
  }, []);

  useEffect(
    () => () => {
      wantListeningRef.current = false;
      generationRef.current += 1;
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
      recognitionRef.current?.abort();
      recognitionRef.current = null;
      releaseMic();
    },
    [releaseMic],
  );

  /** Fallback for browsers without speech recognition (or a noisy street). */
  const submitTyped = useCallback(
    (text: string) => handleFinal(text, null),
    [handleFinal],
  );

  const clearUtterances = useCallback(() => setUtterances([]), []);

  return {
    supported,
    micState,
    listening,
    starting,
    interim,
    level,
    error,
    utterances,
    startRecognition,
    stopRecognition,
    cancelPhrase,
    retryMic,
    submitTyped,
    clearUtterances,
  };
}
