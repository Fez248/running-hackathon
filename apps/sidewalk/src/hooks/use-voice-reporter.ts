'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { parseVoiceReport, type ParsedVoiceReport } from '@sidewalk/core';

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

export function useVoiceReporter({ lang = 'en-US', onReport }: UseVoiceReporterOptions) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [utterances, setUtterances] = useState<VoiceUtterance[]>([]);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const wantListeningRef = useRef(false);
  const onReportRef = useRef(onReport);
  onReportRef.current = onReport;

  useEffect(() => {
    setSupported(recognitionCtor() != null);
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

  const startRecognition = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor) {
      setError('This browser does not support the Web Speech API.');
      return;
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
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        wantListeningRef.current = false;
        setListening(false);
        setError('Microphone permission denied — voice reporting is off.');
        return;
      }
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        setError(event.message || `Speech recognition error: ${event.error}`);
      }
    };

    // Chrome ends the session after a pause even with continuous = true.
    recognition.onend = () => {
      // `abort()` ends asynchronously, so a replaced recogniser must not restart
      // itself off the flag that now belongs to its replacement.
      if (recognitionRef.current !== recognition) return;
      setInterim('');
      if (wantListeningRef.current) {
        try {
          recognition.start();
        } catch {
          setListening(false);
        }
      } else {
        setListening(false);
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      wantListeningRef.current = true;
      setListening(true);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start speech recognition.');
    }
  }, [handleFinal, lang]);

  const stopRecognition = useCallback(() => {
    wantListeningRef.current = false;
    setInterim('');
    setListening(false);
    recognitionRef.current?.abort();
    recognitionRef.current = null;
  }, []);

  useEffect(() => () => {
    wantListeningRef.current = false;
    recognitionRef.current?.abort();
  }, []);

  /** Fallback for browsers without speech recognition (or a noisy street). */
  const submitTyped = useCallback(
    (text: string) => handleFinal(text, null),
    [handleFinal],
  );

  const clearUtterances = useCallback(() => setUtterances([]), []);

  return {
    supported,
    listening,
    interim,
    error,
    utterances,
    startRecognition,
    stopRecognition,
    submitTyped,
    clearUtterances,
  };
}
