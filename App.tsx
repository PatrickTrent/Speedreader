import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { 
  Play, 
  Pause, 
  RotateCcw, 
  Maximize, 
  Upload, 
  Zap, 
  Sparkles, 
  Clock, 
  ChevronRight, 
  ShieldCheck, 
  Coins, 
  FileText,
  BrainCircuit,
  Minimize,
  ExternalLink,
  Scale,
  CreditCard,
  CheckCircle2,
  FileDown,
  Info,
  Type
} from 'lucide-react';
import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { extractRawText } from "mammoth/mammoth.browser.js";
import { COMPANY_LINE } from "./lib/company.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

// --- Constants ---
const WALLET_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAYMENT_UNAVAILABLE = "Payment is temporarily unavailable, you have not been charged";
const SUMMARY_UNAVAILABLE = "Summaries are temporarily unavailable";
const LEGACY_NOTICE = "If you bought credits before this update and they are missing, email speedreader@agentmail.to with your Stripe receipt and we will restore them.";

function displayBalance(data: { exists?: boolean; balance?: number; freeEligible?: boolean }) {
  if (data.exists && typeof data.balance === 'number') return data.balance;
  if (data.freeEligible) return 2;
  return typeof data.balance === 'number' ? data.balance : 0;
}

function packFromBuy(value: string | null): 'SMALL' | 'LARGE' | null {
  if (value === 'starter') return 'SMALL';
  if (value === 'pro') return 'LARGE';
  return null;
}

function readOrCreateWalletId(): string {
  try {
    const saved = localStorage.getItem('walletId');
    if (saved && WALLET_RE.test(saved)) return saved;
    const id = crypto.randomUUID();
    localStorage.setItem('walletId', id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

const DEMO_TEXT = "WELKOM BIJ SPEEDREADER. STOP MET SCANNEN. START MET LEZEN. UPLOAD JE DOCUMENT EN ZIE HOE DEZE READER JE LEESTIJD MET NEGENTIG PROCENT VERLAAGT. GEBRUIK DE SLIDER OM HET LEESTEMPO OP TE VOEREN. DE RODE LETTER IS JE FOCUSPUNT. HIERDOOR HOEVEN JE OGEN NIET MEER TE BEWEGEN. BOVENDIEN KAN DE READER DE TEKST EERST VOOR JE SAMENVATTEN. ONTDEK JE LIMITS EN VERHOOG JE FOCUS. DEZE TEKST BLIJFT HERHALEN ZODAT JE KUNT BLIJVEN OEFENEN.";

const calculateORPIndex = (word: string): number => {
  const len = word.length;
  if (len <= 1) return 0;
  if (len <= 5) return 1;
  if (len <= 9) return 2;
  if (len <= 13) return 3;
  return 4;
};

// --- Sub-Components ---

const LegalModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  const body = [
    "1. Diensten: Trentelman AI Solutions levert een AI-gestuurde snellees-interface.",
    "2. Credits: Credits zijn eenmalige aankopen en geven recht op één AI-summarization sessie per credit.",
    "3. Gebruik: De gebruiker is verantwoordelijk voor de inhoud die wordt geüpload.",
    "4. Garantie: De software wordt geleverd 'as-is'. Gezien de aard van AI is er geen garantie op 100% foutloosheid.",
    "5. Restitutie: Na levering van digitale credits is herroepingsrecht niet van toepassing.",
    "6. Contact: speedreader@agentmail.to"
  ];

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/90 backdrop-blur-md animate-in fade-in">
      <div className="bg-slate-900 border border-slate-700 rounded-[2rem] max-w-2xl w-full p-8 shadow-2xl overflow-y-auto max-h-[80vh]">
        <div className="flex justify-between items-center mb-6 border-b border-slate-800 pb-4">
          <h3 className="text-xl font-black uppercase italic tracking-tighter flex items-center gap-3">
            <Scale size={20} className="text-red-500"/>
            Algemene Voorwaarden
          </h3>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition text-2xl">✕</button>
        </div>
        <div className="space-y-4 text-slate-300 text-sm leading-relaxed">
          {body.map((line, i) => <p key={i}>{line}</p>)}
        </div>
        <button onClick={onClose} className="mt-8 w-full py-3 bg-slate-800 hover:bg-slate-700 rounded-xl font-bold transition">Begrepen</button>
      </div>
    </div>
  );
};

const FAQ_ITEMS = [
  {
    q: "Heb ik een account nodig?",
    a: "Nee. Open speedreader.nl, upload of plak, start RSVP."
  },
  {
    q: "Wat is RSVP?",
    a: "Rapid Serial Visual Presentation — één woord tegelijk op het optimale herkenningspunt zodat je ogen stil blijven en je sneller leest."
  },
  {
    q: "Wanneer betaal ik?",
    a: "Lezen kun je meteen proberen; AI-samenvattingen kosten credits (Starter €0,99/5, Pro €3,99/50)."
  },
  {
    q: "Welke bestanden?",
    a: "PDF, DOCX, of plak platte tekst."
  },
  {
    q: "Voor wie?",
    a: "Indie builders en heavy readers — geen studentenportalen of LinkedIn-funnels."
  },
  {
    q: "Wat gebeurt er met mijn bestand?",
    a: "Een samenvatting gaat via onze server naar Google Gemini. We bewaren de tekst niet. Upload geen geheimen die je niet in een cloud-AI zou plakken."
  }
] as const;

const FaqAccordion: React.FC = () => {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <section id="faq" className="scroll-mt-28 space-y-3">
      <h2 className="text-[11px] text-slate-400 font-black uppercase tracking-[0.2em]">Veelgestelde vragen</h2>
      <div className="border border-slate-800 rounded-2xl overflow-hidden bg-slate-900/40 divide-y divide-slate-800">
        {FAQ_ITEMS.map((item, i) => {
          const isOpen = openIndex === i;
          return (
            <div key={item.q}>
              <button
                type="button"
                aria-expanded={isOpen}
                aria-controls={`faq-panel-${i}`}
                id={`faq-button-${i}`}
                onClick={() => setOpenIndex(isOpen ? null : i)}
                className="w-full flex items-center justify-between gap-4 px-5 py-4 text-left text-sm font-bold text-slate-200 hover:text-white hover:bg-slate-800/50 transition"
              >
                <span>{item.q}</span>
                <ChevronRight
                  size={16}
                  className={`text-red-500 shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                />
              </button>
              <div
                id={`faq-panel-${i}`}
                role="region"
                aria-labelledby={`faq-button-${i}`}
                hidden={!isOpen}
                className="px-5 pb-4 text-sm text-slate-400 leading-relaxed"
              >
                {item.a}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};

const Header: React.FC<{ credits: number | null; onBuyCredits: () => void; paymentsEnabled: boolean }> = ({ credits, onBuyCredits, paymentsEnabled }) => (
  <header className="p-4 md:p-6 flex justify-between items-center border-b border-slate-800 bg-slate-900/50 backdrop-blur-md sticky top-0 z-50">
    <div className="flex items-center gap-4 md:gap-6">
      <a href="/" className="text-xl md:text-3xl font-bold">
        <span className="logo-speed">Speed</span>reader
      </a>
      <nav className="hidden md:flex items-center gap-4" aria-label="How it works">
        <a href="/rsvp" className="text-[9px] text-slate-500 hover:text-red-500 transition font-black uppercase tracking-widest">How it works</a>
        <a href="/read-long-pdf" className="text-[9px] text-slate-500 hover:text-red-500 transition font-black uppercase tracking-widest">Long PDF</a>
        <a href="/ai-summary" className="text-[9px] text-slate-500 hover:text-red-500 transition font-black uppercase tracking-widest">AI Summary</a>
        <a href="/privacy" className="text-[9px] text-slate-500 hover:text-red-500 transition font-black uppercase tracking-widest">Privacy</a>
      </nav>
    </div>
    <div className="flex items-center gap-2 md:gap-4">
       <div className="flex items-center gap-2 bg-amber-500/10 border border-amber-500/20 px-3 py-1.5 md:px-4 md:py-2 rounded-full shadow-[0_0_15px_rgba(245,158,11,0.05)]">
        <Coins size={14} className="text-amber-400 animate-pulse" />
        <span className="text-amber-400 font-black text-[10px] md:text-xs uppercase">{credits === null ? '…' : credits} Credits</span>
      </div>
       <button 
        onClick={onBuyCredits}
        disabled={!paymentsEnabled}
        className="bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-white p-2 md:px-5 md:py-2 rounded-full text-xs font-black transition border border-slate-700 active:scale-95 flex items-center gap-2"
      >
        <Zap size={14} className="text-red-500" fill="currentColor" />
        <span className="hidden md:inline italic uppercase tracking-tighter">Koop Credits</span>
      </button>
    </div>
  </header>
);

const PaymentModal: React.FC<{ isOpen: boolean; onClose: () => void; onPurchase: (type: 'SMALL' | 'LARGE') => void; selectedPack: 'SMALL' | 'LARGE' | null }> = ({ isOpen, onClose, onPurchase, selectedPack }) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/95 backdrop-blur-xl animate-in fade-in duration-300">
      <div className="bg-slate-900 border border-slate-700 rounded-[2.5rem] max-w-xl w-full p-8 shadow-2xl relative">
        <button onClick={onClose} className="absolute top-6 right-6 text-slate-500 hover:text-white transition">✕</button>
        <div className="text-center space-y-6">
          <div className="inline-flex p-4 bg-red-500/10 rounded-2xl text-red-500"><CreditCard size={48} /></div>
          <h2 className="text-3xl font-black italic uppercase tracking-tighter">Upgrade je capaciteit</h2>
          <p className="text-slate-400 text-sm">
            {selectedPack
              ? 'Bevestig het pakket. Er wordt pas betaald als je op de knop drukt.'
              : 'Selecteer een pakket om direct meer AI-summaries vrij te spelen.'}
          </p>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 py-4">
            <div className="bg-slate-800/50 border border-slate-700 p-6 rounded-3xl flex flex-col justify-between gap-6 hover:border-slate-500 transition group">
              <div className="text-left space-y-1">
                <div className="text-amber-500 font-black text-xs uppercase tracking-widest">Starter Pack</div>
                <div className="text-2xl font-black">5 Credits</div>
              </div>
              <div className="text-left">
                <div className="text-3xl font-black">€0,99</div>
              </div>
              <button 
                onClick={() => onPurchase('SMALL')}
                className={`w-full py-3 rounded-xl font-black uppercase italic tracking-tighter transition active:scale-95 ${selectedPack === 'SMALL' ? 'bg-red-500 text-white ring-2 ring-white' : 'bg-white text-black hover:bg-red-500 hover:text-white'}`}
              >
                {selectedPack === 'SMALL' ? 'Bevestig Starter' : 'Koop Nu'}
              </button>
            </div>

            <div className="bg-gradient-to-br from-red-500/10 to-orange-500/10 border-2 border-red-500/40 p-6 rounded-3xl flex flex-col justify-between gap-6 hover:border-red-500 transition relative group">
              <div className="absolute -top-3 right-6 bg-red-500 text-white text-[10px] font-black px-2 py-1 rounded tracking-tighter">BESTE DEAL</div>
              <div className="text-left space-y-1">
                <div className="text-red-500 font-black text-xs uppercase tracking-widest">Pro Pack</div>
                <div className="text-2xl font-black">50 Credits</div>
              </div>
              <div className="text-left">
                <div className="text-3xl font-black">€3,99</div>
                <p className="text-[10px] text-slate-400 font-medium leading-relaxed mt-2">Tien keer meer credits, voor de prijs van vier Starter-packs.</p>
              </div>
              <button 
                onClick={() => onPurchase('LARGE')}
                className={`w-full py-3 bg-red-500 text-white rounded-xl font-black uppercase italic tracking-tighter hover:bg-red-600 transition shadow-lg shadow-red-500/20 active:scale-95 ${selectedPack === 'LARGE' ? 'ring-2 ring-white' : ''}`}
              >
                {selectedPack === 'LARGE' ? 'Bevestig Pro' : 'Koop Nu'}
              </button>
            </div>
          </div>

          <div className="flex items-center justify-center gap-4 pt-4 border-t border-slate-800">
            <ShieldCheck size={16} className="text-green-500" />
            <span className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">Veilige betaling via Stripe</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default function App() {
  const [text, setText] = useState(DEMO_TEXT);
  const [words, setWords] = useState<string[]>(DEMO_TEXT.split(/\s+/));
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [wpm, setWpm] = useState(350);
  const [isSetup, setIsSetup] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);
  const [isCompressing, setIsCompressing] = useState(false);
  const [rawText, setRawText] = useState('');
  const [fileName, setFileName] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showSuccessToast, setShowSuccessToast] = useState(false);
  const [manualText, setManualText] = useState('');
  const [walletId] = useState(readOrCreateWalletId);
  const [credits, setCredits] = useState<number | null>(null);
  const [config, setConfig] = useState<{ payments: boolean; summaries: boolean } | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  const [legacyNotice, setLegacyNotice] = useState(false);
  const [pendingPack, setPendingPack] = useState<'SMALL' | 'LARGE' | null>(null);

  const timerRef = useRef<any>(null);
  const readerContainerRef = useRef<HTMLDivElement>(null);

  const startCheckout = useCallback(async (type: 'SMALL' | 'LARGE') => {
    setPendingPack(null);
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletId, pack: type }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.url) {
        window.location.href = data.url;
        return;
      }
      setPayError(data.message || PAYMENT_UNAVAILABLE);
    } catch (e) {
      console.error(e);
      setPayError(PAYMENT_UNAVAILABLE);
    }
  }, [walletId]);

  useEffect(() => {
    try {
      if (localStorage.getItem('creditBalance') !== null && localStorage.getItem('creditNoticeSeen') !== '1') {
        setLegacyNotice(true);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let payments = false;
      let paymentsKnown = false;
      try {
        const cfgRes = await fetch('/api/config');
        if (cfgRes.ok) {
          const cfg = await cfgRes.json();
          payments = Boolean(cfg.payments);
          paymentsKnown = true;
          if (!cancelled) setConfig({ payments, summaries: Boolean(cfg.summaries) });
        }
      } catch (e) {
        console.error(e);
      }
      try {
        const res = await fetch(`/api/wallet?walletId=${encodeURIComponent(walletId)}`);
        const data = await res.json();
        if (!cancelled) setCredits(displayBalance(data));
      } catch (e) {
        console.error(e);
      }
      if (cancelled) return;

      const params = new URLSearchParams(window.location.search);
      const sessionId = params.get('session_id');
      if (sessionId) {
        setPendingPack(null);
        try {
          const res = await fetch('/api/claim', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: sessionId, walletId }),
          });
          const data = await res.json().catch(() => ({}));
          if (cancelled) return;
          if (data.error === 'wallet_mismatch') {
            alert(data.message || 'These credits were added to the browser that started the payment. Open that browser, or email speedreader@agentmail.to with your Stripe receipt.');
          } else if (res.ok && typeof data.balance === 'number') {
            setCredits(data.balance);
            setShowSuccessToast(true);
            setTimeout(() => setShowSuccessToast(false), 5000);
          }
          if (res.ok || res.status < 500) {
            window.history.replaceState({}, document.title, window.location.pathname);
          }
        } catch (e) {
          console.error(e);
        }
        return;
      }

      const pack = packFromBuy(params.get('buy'));
      if (pack) {
        window.history.replaceState({}, document.title, window.location.pathname);
        setPendingPack(pack);
        if (paymentsKnown && !payments) {
          setPayError(PAYMENT_UNAVAILABLE);
          return;
        }
        setIsModalOpen(true);
      }
    })();
    return () => { cancelled = true; };
  }, [walletId]);

  const togglePlay = () => setIsPlaying(!isPlaying);
  
  const resetReader = () => {
    setIsPlaying(false);
    setCurrentIndex(0);
    setRawText('');
    setFileName('');
    setText(DEMO_TEXT);
    setWords(DEMO_TEXT.split(/\s+/));
    setIsSetup(true);
    setManualText('');
  };

  const toggleFullscreen = () => {
    if (!readerContainerRef.current) return;
    if (!document.fullscreenElement) {
      readerContainerRef.current.requestFullscreen().catch(e => console.error(e));
      setIsFullscreen(true);
    } else {
      if (document.exitFullscreen) document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  useEffect(() => {
    const handleFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  const handleStripePurchase = (type: 'SMALL' | 'LARGE') => {
    if (config && !config.payments) {
      setPayError(PAYMENT_UNAVAILABLE);
      return;
    }
    void startCheckout(type);
  };

  const dismissLegacyNotice = () => {
    try { localStorage.setItem('creditNoticeSeen', '1'); } catch { /* ignore */ }
    setLegacyNotice(false);
  };

  const stats = useMemo(() => {
    if (!rawText) return null;
    const wordCount = rawText.trim().split(/\s+/).length;
    const estimatedAiWords = Math.min(Math.ceil(wordCount * 0.15), 600);
    return { wordCount, estimatedAiWords };
  }, [rawText]);

  const efficiencyFactor = (wpm / 225).toFixed(1);

  const compressText = async () => {
    if (config && !config.summaries) { alert(SUMMARY_UNAVAILABLE); return; }
    if (credits !== null && credits <= 0) { setIsModalOpen(true); return; }

    setIsCompressing(true);
    try {
      const res = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletId, text: rawText.slice(0, 35000) }),
      });
      const data = await res.json().catch(() => ({}));
      if (typeof data.balance === 'number') setCredits(data.balance);
      if (data.error === 'summaries_unavailable' || data.error === 'missing_api_key') {
        alert(data.message || SUMMARY_UNAVAILABLE);
        return;
      }
      if (res.status === 402) { setIsModalOpen(true); return; }
      if (!res.ok || typeof data.summary !== 'string' || !data.summary.trim()) {
        alert("AI Service is momenteel druk. Probeer het over 10 seconden opnieuw.");
        return;
      }
      const summary = data.summary.toUpperCase();
      setText(summary);
      setWords(summary.trim().split(/\s+/));
      setCurrentIndex(0);
      setIsSetup(false);
      setIsPlaying(true);
    } catch (error) {
      alert("AI Service is momenteel druk. Probeer het over 10 seconden opnieuw.");
    } finally {
      setIsCompressing(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsAnalyzing(true);
    setIsPlaying(false);
    setFileName(file.name);
    let extractedText = "";
    try {
      if (file.name.endsWith('.pdf')) {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          extractedText += content.items.map((item: any) => item.str).join(" ") + " ";
        }
      } else if (file.name.endsWith('.docx')) {
        const arrayBuffer = await file.arrayBuffer();
        const result = await extractRawText({ arrayBuffer });
        extractedText = result.value;
      }
      setRawText(extractedText);
      setText(extractedText.toUpperCase());
      setWords(extractedText.toUpperCase().trim().split(/\s+/));
    } catch (err) {
      alert("Kan bestand niet verwerken. Gebruik PDF of DOCX.");
      console.error(err);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleManualTextSubmit = () => {
    if (!manualText.trim()) return;
    setFileName("Gekopieerde Tekst");
    setRawText(manualText);
    setText(manualText.toUpperCase());
    setWords(manualText.toUpperCase().trim().split(/\s+/));
    setIsPlaying(false);
  };

  useEffect(() => {
    if (isPlaying && words.length > 0) {
      const interval = 60000 / wpm;
      timerRef.current = setInterval(() => {
        setCurrentIndex(prev => {
          if (prev + 1 >= words.length) return 0;
          return prev + 1;
        });
      }, interval);
    } else { 
      if (timerRef.current) clearInterval(timerRef.current); 
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [isPlaying, wpm, words]);

  const currentWord = words[currentIndex] || "";
  const orpIndex = calculateORPIndex(currentWord);
  const prefix = currentWord.substring(0, orpIndex);
  const orpLetter = currentWord.substring(orpIndex, orpIndex + 1);
  const suffix = currentWord.substring(orpIndex + 1);
  const progress = words.length > 0 ? currentIndex / words.length : 0;

  return (
    <div className="min-h-screen flex flex-col bg-[#020617] text-white selection:bg-red-500/30 font-sans relative overflow-hidden">
      
      {showSuccessToast && (
        <div className="fixed top-24 left-1/2 -translate-x-1/2 z-[200] animate-in slide-in-from-top-8 duration-500">
          <div className="bg-green-500 text-white px-8 py-4 rounded-3xl font-black uppercase italic tracking-tighter flex items-center gap-4 shadow-[0_0_40px_rgba(34,197,94,0.3)]">
            <CheckCircle2 size={24} /> Betaling geslaagd! Credits toegevoegd.
          </div>
        </div>
      )}

      <Header
        credits={credits}
        paymentsEnabled={config === null || config.payments}
        onBuyCredits={() => {
          if (config && !config.payments) { setPayError(PAYMENT_UNAVAILABLE); return; }
          setIsModalOpen(true);
        }}
      />
      {legacyNotice && (
        <div className="bg-amber-500/15 border-b border-amber-500/30 px-4 py-3 text-sm text-amber-100 flex items-start justify-between gap-4">
          <p>{LEGACY_NOTICE}</p>
          <button type="button" onClick={dismissLegacyNotice} className="text-amber-200 hover:text-white shrink-0">✕</button>
        </div>
      )}
      {(payError || (config && !config.payments)) && (
        <div className="bg-red-500/10 border-b border-red-500/30 px-4 py-3 text-sm text-red-200 text-center">
          {payError || PAYMENT_UNAVAILABLE}
        </div>
      )}
      
      <main className="flex-grow flex flex-col lg:flex-row h-full">
        <div className="w-full lg:w-1/2 p-6 md:p-12 lg:p-16 flex flex-col border-r border-slate-800/50 bg-slate-950/20">
          <div className="space-y-10 py-8 flex-grow">
            <div className="space-y-4">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-red-500/10 border border-red-500/20 text-red-500 text-[10px] font-black uppercase tracking-widest animate-pulse">
                <Sparkles size={12} /> Speedreader
              </div>
              <h1 className="text-4xl md:text-7xl font-black italic tracking-tighter uppercase leading-[0.85]">
                Eén woord <br/><span className="text-transparent bg-clip-text bg-gradient-to-r from-red-500 to-orange-400">tegelijk.</span>
              </h1>
              <p className="text-slate-400 text-sm md:text-base leading-relaxed max-w-xl">
                Je ogen blijven staan. Geen account: PDF/DOCX of plak tekst. AI-samenvatting kost credits (Starter €0,99/5, Pro €3,99/50).
              </p>
            </div>

            <div className="bg-slate-900/50 border border-slate-800 p-6 md:p-8 rounded-[3rem] shadow-2xl relative overflow-hidden group/box">
              <div className="absolute top-0 right-0 p-4 opacity-10 group-hover/box:opacity-30 transition"><BrainCircuit size={80} /></div>
              
              {!rawText ? (
                <div className="space-y-6">
                  {/* Upload Box */}
                  <div className="relative border-2 border-dashed border-slate-800 rounded-[2rem] p-8 hover:border-red-500 transition-all bg-black/40 flex flex-col items-center justify-center gap-4 cursor-pointer h-60 group/upload">
                    <div className="p-4 bg-slate-800 rounded-2xl group-hover/upload:scale-110 group-hover/upload:bg-red-500/10 transition duration-500"><Upload className="text-red-500" size={32} /></div>
                    <div className="text-center">
                      <span className="block text-lg font-black uppercase italic tracking-tighter">Upload Document</span>
                      <span className="text-[9px] text-slate-500 font-bold uppercase tracking-[0.3em] mt-1 block">PDF • DOCX</span>
                    </div>
                    <input type="file" accept=".pdf,.docx" onChange={handleFileUpload} className="absolute inset-0 opacity-0 cursor-pointer" />
                  </div>

                  {/* Manual Input Box */}
                  <div className="bg-black/40 border border-slate-800 rounded-[2rem] p-6 space-y-4">
                    <div className="flex items-center gap-3 text-slate-400">
                      <FileText size={16} />
                      <span className="text-[10px] font-black uppercase tracking-widest">Of plak hier tekst</span>
                    </div>
                    <textarea 
                      value={manualText}
                      onChange={(e) => setManualText(e.target.value)}
                      placeholder="Plak hier de tekst die je wilt snellezen..."
                      className="w-full bg-slate-900/50 border border-slate-800 rounded-xl p-4 text-sm font-medium focus:outline-none focus:border-red-500/50 transition resize-none h-24 text-slate-300"
                    />
                    <button 
                      onClick={handleManualTextSubmit}
                      disabled={!manualText.trim()}
                      className="w-full py-3 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl font-black uppercase italic tracking-tighter transition flex items-center justify-center gap-2"
                    >
                      <Zap size={14} className="text-red-500" /> Tekst Verwerken
                    </button>
                  </div>
                  
                  <div className="flex justify-center">
                    <a
                      href="/privacy"
                      className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-slate-500 hover:text-red-400 transition"
                    >
                      <Info size={14} /> Hoe zit het met mijn data?
                    </a>
                  </div>
                </div>
              ) : (
                <div className="space-y-6 animate-in zoom-in-95">
                  <div className="flex items-center gap-4 p-4 bg-slate-800/40 border border-slate-700 rounded-2xl">
                    <div className="p-3 bg-red-500/10 rounded-xl text-red-500 min-w-[44px] flex justify-center">
                      {fileName === "Gekopieerde Tekst" ? <Type size={20} /> : (fileName.endsWith('.pdf') ? <FileDown size={20} /> : <FileText size={20} />)}
                    </div>
                    <div className="flex-grow min-w-0">
                      <div className="text-xs font-black uppercase tracking-tighter truncate text-slate-200">{fileName}</div>
                      <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">{stats?.wordCount} woorden gedetecteerd</div>
                    </div>
                    <button onClick={resetReader} className="text-slate-500 hover:text-white text-sm px-2 transition">✕</button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <button onClick={() => { setIsSetup(false); setIsPlaying(true); setCurrentIndex(0); }} className="p-6 bg-slate-800/40 border border-slate-700 rounded-[2.5rem] text-left hover:border-slate-500 transition-all flex flex-col justify-between h-60 group/btn">
                      <div className="bg-slate-700 p-3.5 rounded-2xl w-[48px] h-[48px] flex items-center justify-center group-hover/btn:bg-slate-600 transition">
                        <FileText size={22} className="text-slate-200" />
                      </div>
                      <div className="space-y-2">
                        <div className="font-black italic uppercase tracking-tighter text-lg leading-none">Volledig Lezen</div>
                        <div className="text-[10px] text-slate-300 font-medium uppercase tracking-tight leading-relaxed">
                          Lees alle {stats?.wordCount} woorden in hun originele context.
                        </div>
                      </div>
                    </button>
                    
                    <button 
                      onClick={compressText} 
                      disabled={isCompressing || config?.summaries === false} 
                      className={`p-6 bg-gradient-to-br from-red-500/10 to-orange-500/10 border border-red-500/20 rounded-[2.5rem] text-left hover:border-red-500 transition-all flex flex-col justify-between h-60 relative overflow-hidden group/btn disabled:opacity-50 disabled:cursor-not-allowed ${isCompressing ? 'animate-pulse' : ''}`}
                    >
                      {isCompressing && (
                        <>
                          <div className="absolute inset-0 z-10 overflow-hidden pointer-events-none">
                            <div className="absolute top-0 bottom-0 w-[4px] bg-red-500 shadow-[0_0_15px_#ef4444] animate-[scan_2s_linear_infinite]" />
                            <style>{`
                              @keyframes scan {
                                0% { left: -10%; }
                                100% { left: 110%; }
                              }
                            `}</style>
                          </div>
                          <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px] flex flex-col items-center justify-center z-20 gap-3">
                            <div className="animate-spin rounded-full h-10 w-10 border-4 border-slate-700 border-t-red-500" />
                            <span className="text-[10px] font-black text-red-500 tracking-[0.3em] animate-pulse">ANALYZING...</span>
                          </div>
                        </>
                      )}
                      <div className="bg-red-500/20 p-3.5 rounded-2xl w-[48px] h-[48px] flex items-center justify-center group-hover/btn:bg-red-500/30 transition">
                        <BrainCircuit size={22} className="text-red-500" />
                      </div>
                      <div className="space-y-2">
                        <div className="font-black italic uppercase tracking-tighter text-lg text-red-400 leading-none">AI Summary</div>
                        <div className="text-[10px] text-red-200 font-medium uppercase tracking-tight leading-relaxed">
                          {config?.summaries === false
                            ? SUMMARY_UNAVAILABLE
                            : `Vat samen tot ~${stats?.estimatedAiWords} woorden (schatting). Bespaar tijd.`}
                        </div>
                      </div>
                    </button>
                  </div>
                </div>
              )}
            </div>

            <FaqAccordion />
          </div>

          <footer className="pt-8 pb-4 border-t border-slate-800/30 hidden lg:block">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-end">
              <div className="space-y-3">
                <div className="text-[11px] text-slate-400 font-medium tracking-tight leading-relaxed normal-case">
                  {COMPANY_LINE}
                </div>
              </div>
              <div className="flex flex-wrap gap-6">
                <a href="/rsvp" className="text-[9px] text-slate-600 hover:text-red-500 transition font-black uppercase">RSVP</a>
                <a href="/read-long-pdf" className="text-[9px] text-slate-600 hover:text-red-500 transition font-black uppercase">Long PDF</a>
                <a href="/ai-summary" className="text-[9px] text-slate-600 hover:text-red-500 transition font-black uppercase">AI Summary</a>
                <a href="/for-builders" className="text-[9px] text-slate-600 hover:text-red-500 transition font-black uppercase">For Builders</a>
                <a href="#faq" className="text-[9px] text-slate-600 hover:text-red-500 transition font-black uppercase">FAQ</a>
                <a href="/privacy" className="text-[9px] text-slate-600 hover:text-red-500 transition font-black uppercase">Privacy</a>
                <button onClick={() => setTermsOpen(true)} className="text-[9px] text-slate-600 hover:text-red-500 transition font-black uppercase">Voorwaarden</button>
              </div>
            </div>
          </footer>
        </div>

        <div id="reader" ref={readerContainerRef} className={`w-full lg:w-1/2 flex flex-col bg-black relative min-h-[600px] transition-all duration-700 ${isFullscreen ? 'h-screen' : ''}`}>
          <div className="absolute top-0 left-0 right-0 h-1.5 bg-slate-900 z-20">
            <div className="h-full bg-red-500 shadow-[0_0_25px_#ef4444] transition-all duration-300" style={{ width: `${progress * 100}%` }} />
          </div>

          <div className="flex-grow flex flex-col items-center justify-center relative overflow-hidden">
             <div className="absolute left-1/2 top-0 bottom-0 w-[1px] bg-white/5 -translate-x-1/2" />
             <div className={`font-mono font-black flex relative z-10 w-full justify-center items-center pointer-events-none transition-all ${isFullscreen ? 'text-[11rem]' : 'text-6xl md:text-9xl'}`}>
                <div className="w-1/2 text-right pr-[0.1em] text-slate-200 overflow-hidden whitespace-nowrap opacity-90">{prefix}</div>
                <div className="text-red-500 drop-shadow-[0_0_50px_rgba(239,68,68,0.8)] w-[0.65em] text-center flex-shrink-0">{orpLetter}</div>
                <div className="w-1/2 text-left pl-[0.1em] text-slate-200 overflow-hidden whitespace-nowrap opacity-90">{suffix}</div>
             </div>

             {currentIndex === 0 && !isPlaying && (
               <div onClick={togglePlay} className="absolute inset-0 bg-black/85 backdrop-blur-xl flex items-center justify-center cursor-pointer z-30 group">
                 <div className="flex flex-col items-center gap-8 animate-in fade-in zoom-in duration-700">
                    <div className="p-12 bg-red-500 text-white rounded-full group-hover:scale-110 transition shadow-[0_0_80px_rgba(239,68,68,0.4)] animate-pulse">
                      <Play size={64} fill="currentColor" />
                    </div>
                    <span className="block text-lg font-black uppercase tracking-[0.6em] text-red-500">Launch Reader</span>
                 </div>
               </div>
             )}
          </div>

          <div className={`p-8 md:p-14 bg-slate-950 border-t border-slate-900 z-40 transition-all ${isFullscreen ? 'absolute bottom-10 left-1/2 -translate-x-1/2 w-[90%] max-w-3xl bg-slate-900/60 backdrop-blur-2xl rounded-[3rem] border border-white/5' : ''}`}>
            <div className="max-w-2xl mx-auto space-y-10 relative">
              
              <div className="absolute -top-12 right-4 flex flex-col items-end pointer-events-none">
                <div className="text-[10px] font-black uppercase text-slate-500 tracking-widest mb-1 italic">Efficiency Factor</div>
                <div className="text-red-500 font-black italic text-sm drop-shadow-[0_0_8px_rgba(239,68,68,0.5)]">
                  {efficiencyFactor}x sneller dan gemiddeld
                </div>
              </div>

              <div className="space-y-6">
                <div className="flex justify-between items-end px-4">
                  <span className="text-[10px] font-black text-slate-600 uppercase">Cruising</span>
                  <div className="bg-red-500/10 border border-red-500/20 px-10 py-4 rounded-3xl text-center relative">
                    <span className="text-5xl font-black italic tracking-tighter leading-none">{wpm}</span>
                    <span className="text-[10px] font-bold text-red-500/50 block mt-1 uppercase">Words/Min</span>
                  </div>
                  <span className="text-[10px] font-black text-slate-600 uppercase">Sonic</span>
                </div>
                <input type="range" min="150" max="1200" step="10" value={wpm} onChange={(e) => setWpm(Number(e.target.value))} className="w-full cursor-pointer accent-red-500 h-2.5 bg-slate-800/40 rounded-full appearance-none" />
              </div>

              <div className="flex justify-between items-center px-4">
                <button onClick={resetReader} className="p-5 text-slate-600 hover:text-white transition group"><RotateCcw size={28} /></button>
                <button onClick={togglePlay} className="w-24 h-24 rounded-full bg-white text-black flex items-center justify-center hover:scale-105 active:scale-95 transition shadow-lg group">
                  {isPlaying ? <Pause size={40} fill="currentColor" /> : <Play size={40} fill="currentColor" className="ml-1.5" />}
                </button>
                <button onClick={toggleFullscreen} className="p-5 text-slate-600 hover:text-white transition">
                  {isFullscreen ? <Minimize size={28} /> : <Maximize size={28} />}
                </button>
              </div>
            </div>
          </div>
        </div>
      </main>

      <footer className="p-6 border-t border-slate-800/30 lg:hidden bg-slate-950/50">
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="text-[11px] text-slate-400 font-medium tracking-tight leading-relaxed normal-case">
              {COMPANY_LINE}
            </div>
          </div>
          <div className="flex flex-wrap gap-6 pt-2">
            <a href="/rsvp" className="text-[9px] text-slate-600 hover:text-red-500 transition font-black uppercase">RSVP</a>
            <a href="/read-long-pdf" className="text-[9px] text-slate-600 hover:text-red-500 transition font-black uppercase">Long PDF</a>
            <a href="/ai-summary" className="text-[9px] text-slate-600 hover:text-red-500 transition font-black uppercase">AI Summary</a>
            <a href="/for-builders" className="text-[9px] text-slate-600 hover:text-red-500 transition font-black uppercase">For Builders</a>
            <a href="#faq" className="text-[9px] text-slate-600 hover:text-red-500 transition font-black uppercase">FAQ</a>
            <a href="/privacy" className="text-[9px] text-slate-600 hover:text-red-500 transition font-black uppercase">Privacy</a>
            <button onClick={() => setTermsOpen(true)} className="text-[9px] text-slate-600 hover:text-red-500 transition font-black uppercase">Voorwaarden</button>
          </div>
        </div>
      </footer>

      <PaymentModal isOpen={isModalOpen} onClose={() => { setIsModalOpen(false); setPendingPack(null); }} onPurchase={handleStripePurchase} selectedPack={pendingPack} />
      <LegalModal isOpen={termsOpen} onClose={() => setTermsOpen(false)} />
    </div>
  );
}