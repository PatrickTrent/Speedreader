import React, { useState, useEffect, useRef, useMemo } from 'react';
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
  Lock,
  FileText,
  BrainCircuit,
  Minimize,
  ExternalLink,
  Scale,
  Shield,
  CreditCard,
  CheckCircle2,
  FileDown,
  Info,
  Type
} from 'lucide-react';
import { GoogleGenAI } from "@google/genai";

// --- Constants ---
const API_KEY = process.env.API_KEY;

/** 
 * STRIPE CONFIGURATIE (LIVE MODUS)
 */
const STRIPE_PUBLIC_KEY = "pk_live_51SpXwgGZNUPNxvCO7ZmYAxzvd1QWl3l3IgHBPmz34j6qeZxBn2oDtkp8ovmAvrfO8kstWeherLjEbGKgkDWGywUU00vOdGyjvd";

/**
 * STRIPE PAYMENT LINKS (LIVE)
 * Starter 5 credits / €0,99 and Pro 50 credits / €3,99.
 */
const PAYMENT_LINKS = {
  SMALL: "https://buy.stripe.com/4gM5kD2U2bao76u9kA0Fi00",
  LARGE: "https://buy.stripe.com/28E14nfGOemAbmK40g0Fi01"
};

const DEMO_TEXT = "WELKOM BIJ SPEEDREADER PRO. STOP MET SCANNEN. START MET LEZEN. UPLOAD JE DOCUMENT EN ZIE HOE DEZE READER JE LEESTIJD MET NEGENTIG PROCENT VERLAAGT. GEBRUIK DE SLIDER OM HET LEESTEMPO OP TE VOEREN. DE RODE LETTER IS JE FOCUSPUNT. HIERDOOR HOEVEN JE OGEN NIET MEER TE BEWEGEN. BOVENDIEN KAN DE READER DE TEKST EERST VOOR JE SAMENVATTEN. ONTDEK JE LIMITS EN VERHOOG JE FOCUS. DEZE TEKST BLIJFT HERHALEN ZODAT JE KUNT BLIJVEN OEFENEN.";

const calculateORPIndex = (word: string): number => {
  const len = word.length;
  if (len <= 1) return 0;
  if (len <= 5) return 1;
  if (len <= 9) return 2;
  if (len <= 13) return 3;
  return 4;
};

// --- Sub-Components ---

const LegalModal: React.FC<{ isOpen: boolean; type: 'terms' | 'privacy' | 'data'; onClose: () => void }> = ({ isOpen, type, onClose }) => {
  if (!isOpen) return null;
  
  const getContent = () => {
    switch(type) {
      case 'terms':
        return {
          title: "Algemene Voorwaarden",
          icon: <Scale size={20} className="text-red-500"/>,
          body: [
            "1. Diensten: Trentelman AI Solutions levert een AI-gestuurde snellees-interface.",
            "2. Credits: Credits zijn eenmalige aankopen en geven recht op één AI-summarization sessie per credit.",
            "3. Gebruik: De gebruiker is verantwoordelijk voor de inhoud die wordt geüpload.",
            "4. Garantie: De software wordt geleverd 'as-is'. Gezien de aard van AI is er geen garantie op 100% foutloosheid.",
            "5. Restitutie: Na levering van digitale credits is herroepingsrecht niet van toepassing.",
            "6. Contact: support@trentelman-ai.nl"
          ]
        };
      case 'privacy':
        return {
          title: "Privacy Policy",
          icon: <Shield size={20} className="text-red-500"/>,
          body: [
            "1. Data: Wij slaan documenten niet permanent op. Tekst wordt enkel tijdelijk verwerkt.",
            "2. AI: Verwerking vindt plaats via beveiligde Google Cloud infrastructuur.",
            "3. Stripe: Transacties verlopen via Stripe. Wij zien uw kaartgegevens niet.",
            "4. Opslag: Uw credit-saldo wordt lokaal op uw apparaat bewaard."
          ]
        };
      case 'data':
        return {
          title: "Hoe zit het met mijn data?",
          icon: <Lock size={20} className="text-red-500"/>,
          body: [
            "Simpel: we bewaren niks. Zodra jij je document uploadt, leest onze AI het, geeft de samenvatting, en vergeet het daarna direct.",
            "We have no database with your files.",
            "Toch een tip: upload liever geen bestanden met wachtwoorden of gevoelige privégegevens. Better safe than sorry."
          ]
        };
    }
  };

  const content = getContent();

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/90 backdrop-blur-md animate-in fade-in">
      <div className="bg-slate-900 border border-slate-700 rounded-[2rem] max-w-2xl w-full p-8 shadow-2xl overflow-y-auto max-h-[80vh]">
        <div className="flex justify-between items-center mb-6 border-b border-slate-800 pb-4">
          <h3 className="text-xl font-black uppercase italic tracking-tighter flex items-center gap-3">
            {content.icon}
            {content.title}
          </h3>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition text-2xl">✕</button>
        </div>
        <div className="space-y-4 text-slate-300 text-sm leading-relaxed">
          {content.body.map((line, i) => <p key={i}>{line}</p>)}
        </div>
        <button onClick={onClose} className="mt-8 w-full py-3 bg-slate-800 hover:bg-slate-700 rounded-xl font-bold transition">Begrepen</button>
      </div>
    </div>
  );
};

const Header: React.FC<{ credits: number; onBuyCredits: () => void }> = ({ credits, onBuyCredits }) => (
  <header className="p-4 md:p-6 flex justify-between items-center border-b border-slate-800 bg-slate-900/50 backdrop-blur-md sticky top-0 z-50">
    <div className="flex items-center gap-2">
      <h1 className="text-xl md:text-3xl font-bold">
        <span className="logo-speed">Speed</span>Reader
      </h1>
    </div>
    <div className="flex items-center gap-2 md:gap-4">
       <div className="flex items-center gap-2 bg-amber-500/10 border border-amber-500/20 px-3 py-1.5 md:px-4 md:py-2 rounded-full shadow-[0_0_15px_rgba(245,158,11,0.05)]">
        <Coins size={14} className="text-amber-400 animate-pulse" />
        <span className="text-amber-400 font-black text-[10px] md:text-xs uppercase">{credits} Credits</span>
      </div>
       <button 
        onClick={onBuyCredits}
        className="bg-slate-800 hover:bg-slate-700 text-white p-2 md:px-5 md:py-2 rounded-full text-xs font-black transition border border-slate-700 active:scale-95 flex items-center gap-2"
      >
        <Zap size={14} className="text-red-500" fill="currentColor" />
        <span className="hidden md:inline italic uppercase tracking-tighter">Koop Credits</span>
      </button>
    </div>
  </header>
);

const PaymentModal: React.FC<{ isOpen: boolean; onClose: () => void; onPurchase: (type: 'SMALL' | 'LARGE') => void }> = ({ isOpen, onClose, onPurchase }) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/95 backdrop-blur-xl animate-in fade-in duration-300">
      <div className="bg-slate-900 border border-slate-700 rounded-[2.5rem] max-w-xl w-full p-8 shadow-2xl relative">
        <button onClick={onClose} className="absolute top-6 right-6 text-slate-500 hover:text-white transition">✕</button>
        <div className="text-center space-y-6">
          <div className="inline-flex p-4 bg-red-500/10 rounded-2xl text-red-500"><CreditCard size={48} /></div>
          <h2 className="text-3xl font-black italic uppercase tracking-tighter">Upgrade je capaciteit</h2>
          <p className="text-slate-400 text-sm">Selecteer een pakket om direct meer AI-summaries vrij te spelen.</p>
          
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
                className="w-full py-3 bg-white text-black rounded-xl font-black uppercase italic tracking-tighter hover:bg-red-500 hover:text-white transition active:scale-95"
              >
                Koop Nu
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
                className="w-full py-3 bg-red-500 text-white rounded-xl font-black uppercase italic tracking-tighter hover:bg-red-600 transition shadow-lg shadow-red-500/20 active:scale-95"
              >
                Koop Nu
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
  const [legalModal, setLegalModal] = useState<{ open: boolean; type: 'terms' | 'privacy' | 'data' }>({ open: false, type: 'terms' });
  const [isCompressing, setIsCompressing] = useState(false);
  const [rawText, setRawText] = useState('');
  const [fileName, setFileName] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showSuccessToast, setShowSuccessToast] = useState(false);
  const [manualText, setManualText] = useState('');
  
  // Persistent Credits Logic: Standard is 2 for Free Trial
  const [credits, setCredits] = useState(() => {
    try {
      const saved = localStorage.getItem('creditBalance');
      return saved !== null ? parseInt(saved, 10) : 2;
    } catch { 
      return 2; 
    }
  });

  // Sync credits with localStorage on every change
  useEffect(() => {
    localStorage.setItem('creditBalance', credits.toString());
  }, [credits]);

  const timerRef = useRef<any>(null);
  const readerContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.get('success') === 'true') {
        const amountStr = urlParams.get('credits');
        if (amountStr) {
          const amount = parseInt(amountStr, 10);
          setCredits(prev => prev + amount);
          window.history.replaceState({}, document.title, window.location.pathname);
          setShowSuccessToast(true);
          setTimeout(() => setShowSuccessToast(false), 5000);
        }
      }
    } catch (e) { console.error("URL Params Error", e); }
  }, []);

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
    const link = PAYMENT_LINKS[type];
    if (link) {
      window.location.href = link;
    }
  };

  const stats = useMemo(() => {
    if (!rawText) return null;
    const wordCount = rawText.trim().split(/\s+/).length;
    const estimatedAiWords = Math.min(Math.ceil(wordCount * 0.15), 600);
    return { wordCount, estimatedAiWords };
  }, [rawText]);

  const efficiencyFactor = (wpm / 225).toFixed(1);

  const compressText = async () => {
    if (credits <= 0) { setIsModalOpen(true); return; }
    if (!API_KEY) { alert("Systeemfout: API Key ontbreekt."); return; }
    
    setIsCompressing(true);
    const ai = new GoogleGenAI({ apiKey: API_KEY });
    
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Taak: Vat dit document samen voor een snellezer. Focus op kernboodschappen. Gebruik maximaal 600 woorden. Document: ${rawText.substring(0, 35000)}`,
        config: { 
          systemInstruction: "Je bent een executive summary bot. Geef een vloeiende tekst terug voor snellezen in hoofdletters voor betere focus." 
        }
      });
      
      const summary = (response.text || "").toUpperCase();
      setText(summary);
      setWords(summary.trim().split(/\s+/));
      setCurrentIndex(0);
      setIsSetup(false);
      setIsPlaying(true);
      setCredits(prev => prev - 1);
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
        // @ts-ignore
        if (typeof window.pdfjsLib !== 'undefined') {
          // @ts-ignore
          const pdf = await window.pdfjsLib.getDocument(arrayBuffer).promise;
          for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            extractedText += content.items.map((item: any) => item.str).join(" ") + " ";
          }
        } else { throw new Error("PDF library not loaded"); }
      } else if (file.name.endsWith('.docx')) {
        const arrayBuffer = await file.arrayBuffer();
        // @ts-ignore
        if (typeof window.mammoth !== 'undefined') {
          // @ts-ignore
          const result = await window.mammoth.extractRawText({ arrayBuffer });
          extractedText = result.value;
        } else { throw new Error("Word library not loaded"); }
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

      <Header credits={credits} onBuyCredits={() => setIsModalOpen(true)} />
      
      <main className="flex-grow flex flex-col lg:flex-row h-full">
        <div className="w-full lg:w-1/2 p-6 md:p-12 lg:p-16 flex flex-col border-r border-slate-800/50 bg-slate-950/20">
          <div className="space-y-10 py-8 flex-grow">
            <div className="space-y-4">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-red-500/10 border border-red-500/20 text-red-500 text-[10px] font-black uppercase tracking-widest animate-pulse">
                <Sparkles size={12} /> SpeedReader Pro v2.5
              </div>
              <h2 className="text-4xl md:text-7xl font-black italic tracking-tighter uppercase leading-[0.85]">
                Eén woord <br/><span className="text-transparent bg-clip-text bg-gradient-to-r from-red-500 to-orange-400">tegelijk.</span>
              </h2>
              <p className="text-slate-400 text-sm md:text-base leading-relaxed max-w-xl">
                Je ogen blijven staan. RSVP-lezer is gratis, geen account. AI-samenvatting als je eerst de kern wilt.
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
                    <button 
                      onClick={() => setLegalModal({ open: true, type: 'data' })}
                      className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-slate-500 hover:text-red-400 transition"
                    >
                      <Info size={14} /> Hoe zit het met mijn data?
                    </button>
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
                      disabled={isCompressing} 
                      className={`p-6 bg-gradient-to-br from-red-500/10 to-orange-500/10 border border-red-500/20 rounded-[2.5rem] text-left hover:border-red-500 transition-all flex flex-col justify-between h-60 relative overflow-hidden group/btn ${isCompressing ? 'animate-pulse' : ''}`}
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
                          Vat samen tot ~{stats?.estimatedAiWords} woorden (schatting). Bespaar tijd.
                        </div>
                      </div>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <footer className="pt-8 pb-4 border-t border-slate-800/30 hidden lg:block">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-end">
              <div className="space-y-3">
                <div className="text-[11px] text-slate-400 font-black uppercase tracking-[0.2em]">Trentelman AI Solutions</div>
                <div className="text-[10px] text-slate-600 font-medium uppercase tracking-tighter leading-relaxed">
                  KVK: 916886210 | BTW: NL004908763B50 <br/> Locatie: Groningen, Nederland
                </div>
              </div>
              <div className="flex gap-6">
                <button onClick={() => setLegalModal({ open: true, type: 'terms' })} className="text-[9px] text-slate-600 hover:text-red-500 transition font-black uppercase">Voorwaarden</button>
                <button onClick={() => setLegalModal({ open: true, type: 'privacy' })} className="text-[9px] text-slate-600 hover:text-red-500 transition font-black uppercase">Privacy</button>
              </div>
            </div>
          </footer>
        </div>

        <div ref={readerContainerRef} className={`w-full lg:w-1/2 flex flex-col bg-black relative min-h-[600px] transition-all duration-700 ${isFullscreen ? 'h-screen' : ''}`}>
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
            <div className="text-[11px] text-slate-400 font-black uppercase tracking-[0.2em]">Trentelman AI Solutions</div>
            <div className="text-[10px] text-slate-600 font-medium uppercase tracking-tighter leading-relaxed">
              KVK: 916886210 | BTW: NL004908763B50 <br/> Locatie: Groningen, Nederland
            </div>
          </div>
          <div className="flex gap-6 pt-2">
            <button onClick={() => setLegalModal({ open: true, type: 'terms' })} className="text-[9px] text-slate-600 hover:text-red-500 transition font-black uppercase">Voorwaarden</button>
            <button onClick={() => setLegalModal({ open: true, type: 'privacy' })} className="text-[9px] text-slate-600 hover:text-red-500 transition font-black uppercase">Privacy</button>
          </div>
        </div>
      </footer>

      <PaymentModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} onPurchase={handleStripePurchase} />
      <LegalModal isOpen={legalModal.open} type={legalModal.type} onClose={() => setLegalModal({ ...legalModal, open: false })} />
    </div>
  );
}