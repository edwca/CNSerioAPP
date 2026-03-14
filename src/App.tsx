/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { 
  signInWithPopup, 
  GoogleAuthProvider, 
  onAuthStateChanged, 
  User,
  signOut 
} from 'firebase/auth';
import { 
  collection, 
  addDoc, 
  query, 
  where, 
  onSnapshot, 
  serverTimestamp,
  doc,
  getDoc,
  setDoc,
  getDocFromServer
} from 'firebase/firestore';
import { auth, db } from './firebase';
import { UserProfile, SOSRequest, Office } from './types';
import { motion, AnimatePresence } from 'motion/react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import { 
  AlertCircle, 
  Phone, 
  User as UserIcon, 
  LogOut, 
  ShieldCheck, 
  Fingerprint,
  CheckCircle2,
  Clock,
  MapPin,
  X,
  Edit2,
  Save
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { QRCodeSVG } from 'qrcode.react';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Constants ---
const GOOGLE_PROVIDER = new GoogleAuthProvider();

// Fix for Leaflet default icon issue
// @ts-ignore
delete L.Icon.Default.prototype._getIconUrl;

const redIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41]
});

L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

// Component to center map on selected office
function ChangeView({ center }: { center: [number, number] }) {
  const map = useMap();
  map.setView(center, 15);
  return null;
}

// Mock data for Consalud offices
const MOCK_OFFICES: Office[] = [
  { id: '1', name: 'Consalud Providencia', address: 'Av. Providencia 1234', lat: -33.4372, lng: -70.6156 },
  { id: '2', name: 'Consalud Santiago Centro', address: 'Paseo Ahumada 45', lat: -33.4444, lng: -70.6500 },
  { id: '3', name: 'Consalud Las Condes', address: 'Av. Apoquindo 4500', lat: -33.4125, lng: -70.5789 },
];

type View = 'sos' | 'profile' | 'sedes';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [isVerifying, setIsVerifying] = useState(false);
  const [verificationProgress, setVerificationProgress] = useState(0);
  const [sosActive, setSosActive] = useState(false);
  const [requests, setRequests] = useState<SOSRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [currentView, setCurrentView] = useState<View>('sos');
  const [isFetchingProfile, setIsFetchingProfile] = useState(false);
  const [nearbyOffices, setNearbyOffices] = useState<Office[]>(MOCK_OFFICES);
  const [selectedOfficeId, setSelectedOfficeId] = useState<string | null>(MOCK_OFFICES[0].id);
  const [showConsent, setShowConsent] = useState(false);
  const [showConsentConfirm, setShowConsentConfirm] = useState(false);
  const [hasDismissedConsent, setHasDismissedConsent] = useState(false);
  const [show2FA, setShow2FA] = useState(false);
  const [show2FAConfirm, setShow2FAConfirm] = useState(false);
  const [twoFASecret, setTwoFASecret] = useState('');
  const [twoFACode, setTwoFACode] = useState('');
  const [showMap, setShowMap] = useState(false);
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [editData, setEditData] = useState<Partial<UserProfile>>({});
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const formatRut = (rut: string) => {
    let value = rut.replace(/\./g, '').replace('-', '');
    if (value.length <= 1) return value;
    let body = value.slice(0, -1);
    let dv = value.slice(-1).toUpperCase();
    body = body.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    return `${body}-${dv}`;
  };

  const validateRut = (rut: string) => {
    if (!rut) return false;
    let value = rut.replace(/\./g, '').replace('-', '');
    if (value.length < 8) return false;
    let body = value.slice(0, -1);
    let dv = value.slice(-1).toUpperCase();
    
    let sum = 0;
    let mul = 2;
    for (let i = body.length - 1; i >= 0; i--) {
      sum += parseInt(body[i]) * mul;
      mul = mul === 7 ? 2 : mul + 1;
    }
    let res = 11 - (sum % 11);
    let expectedDv = res === 11 ? '0' : res === 10 ? 'K' : res.toString();
    return dv === expectedDv;
  };

  const validateName = (name: string) => /^[a-zA-ZáéíóúÁÉÍÓÚñÑ\s]+$/.test(name || '');
  const validatePhone = (phone: string) => /^\d{8}$/.test(phone || '');
  const validatePlan = (plan: string) => /^[a-zA-Z0-9\s]{3,50}$/.test(plan || '');
  const validateAddress = (address: string) => (address || '').length >= 10 && (address || '').length <= 50;
  const validateAddressNumber = (num: string) => /^\d+$/.test(num || '');

  const isProfileValid = () => {
    return (
      validateRut(editData.rut || '') &&
      validateName(editData.displayName || '') &&
      validatePhone(editData.phoneNumber || '') &&
      validatePlan(editData.healthPlan || '') &&
      validateAddress(editData.address || '') &&
      validateAddressNumber(editData.addressNumber || '')
    );
  };
  
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // --- API Call Simulation ---
  const fetchClientData = async (rut: string) => {
    setIsFetchingProfile(true);
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    const mockData = {
      displayName: "Juan Pérez González",
      healthPlan: "Plan-XX-XX",
      address: "Av. Libertador Bernardo O'Higgins 123, Santiago",
      phoneNumber: "+56 9 8765 4321"
    };
    
    if (profile) {
      const updatedProfile = { ...profile, ...mockData, rut };
      await setDoc(doc(db, 'users', profile.uid), updatedProfile);
      setProfile(updatedProfile);
    }
    setIsFetchingProfile(false);
    speak("Datos de perfil actualizados correctamente.");
  };

  // --- TTS Helper ---
  const speak = (text: string) => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'es-ES';
      utterance.rate = 0.9;
      window.speechSynthesis.speak(utterance);
    }
  };

  // --- Firebase Auth & Profile ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        setUser(firebaseUser);
        const docRef = doc(db, 'users', firebaseUser.uid);
        const docSnap = await getDoc(docRef);
        
        if (docSnap.exists()) {
          const data = docSnap.data() as UserProfile;
          setProfile(data);
          if (!data.dataConsentAccepted) {
            setShowConsent(true);
          }
        } else {
          const newProfile: UserProfile = {
            uid: firebaseUser.uid,
            displayName: firebaseUser.displayName || 'Usuario',
            email: firebaseUser.email || '',
            role: 'senior',
            dataConsentAccepted: false
          };
          await setDoc(docRef, newProfile);
          setProfile(newProfile);
          setShowConsent(true);
        }
      } else {
        setUser(null);
        setProfile(null);
        setShowConsent(false);
        setShow2FA(false);
      }
      setLoading(false);
    });

    const testConnection = async () => {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (err) {
        if (err instanceof Error && err.message.includes('the client is offline')) {
          setError("Error de conexión con la base de datos.");
        }
      }
    };
    testConnection();

    return () => unsubscribe();
  }, []);

  // --- SOS Requests Listener ---
  useEffect(() => {
    if (!profile) return;

    const q = profile.role === 'senior' 
      ? query(collection(db, 'sos_requests'), where('seniorId', '==', profile.uid))
      : query(collection(db, 'sos_requests'), where('executiveId', '==', profile.uid));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const docs = snapshot.docs.map(d => ({ id: d.id, ...d.data() } as SOSRequest));
      setRequests(docs.sort((a, b) => b.timestamp?.seconds - a.timestamp?.seconds));
    }, (err) => {
      console.error("Firestore Error:", err);
    });

    return () => unsubscribe();
  }, [profile]);

  // --- Handlers ---
  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, GOOGLE_PROVIDER);
    } catch (err) {
      console.error(err);
      setError("Error al iniciar sesión.");
    }
  };

  const handleLogout = () => signOut(auth);

  const toggleEditingProfile = () => {
    if (profile) {
      if (!isEditingProfile) {
        setEditData({
          displayName: profile.displayName,
          phoneNumber: profile.phoneNumber,
          rut: profile.rut,
          address: profile.address,
          addressNumber: profile.addressNumber,
          apartment: profile.apartment,
          healthPlan: profile.healthPlan
        });
      }
      setIsEditingProfile(!isEditingProfile);
    }
  };

  const handleSaveProfile = async () => {
    if (profile) {
      try {
        const rawProfile = { ...profile, ...editData };
        // Remove undefined values as Firestore doesn't support them
        const updatedProfile = Object.fromEntries(
          Object.entries(rawProfile).filter(([_, v]) => v !== undefined)
        ) as unknown as UserProfile;

        await setDoc(doc(db, 'users', profile.uid), updatedProfile);
        setProfile(updatedProfile);
        setIsEditingProfile(false);
        setSuccessMessage("¡Perfil actualizado con éxito!");
        speak("Perfil actualizado correctamente.");
        setTimeout(() => setSuccessMessage(null), 3000);
      } catch (err) {
        console.error(err);
        setError("Error al guardar los datos. Intente nuevamente.");
      }
    }
  };

  const resetConsent = async () => {
    if (profile?.dataConsentAccepted) {
      setShowConsentConfirm(true);
    } else {
      confirmResetConsent();
    }
  };

  const confirmResetConsent = async () => {
    if (profile) {
      const updatedProfile = { ...profile, dataConsentAccepted: false };
      await setDoc(doc(db, 'users', profile.uid), updatedProfile);
      setProfile(updatedProfile);
      setHasDismissedConsent(false);
      setShowConsentConfirm(false);
      setShowConsent(true);
      speak("Consentimiento reiniciado. Por favor, revise los términos.");
    }
  };

  const resetTwoFA = async () => {
    if (profile?.twoFAEnabled) {
      setShow2FAConfirm(true);
    } else {
      confirmResetTwoFA();
    }
  };

  const confirmResetTwoFA = async () => {
    if (profile) {
      // Generate a simulated secret for the QR code
      const secret = Math.random().toString(36).substring(2, 10).toUpperCase();
      setTwoFASecret(secret);
      
      const updatedProfile = { ...profile, twoFAEnabled: false };
      await setDoc(doc(db, 'users', profile.uid), updatedProfile);
      setProfile(updatedProfile);
      setShow2FAConfirm(false);
      setShow2FA(true);
      speak("Doble factor reiniciado. Por favor, escanee el nuevo código QR.");
    }
  };

  const startVerification = () => {
    setIsVerifying(true);
    setVerificationProgress(0);
    
    let progress = 0;
    timerRef.current = setInterval(() => {
      progress += 2;
      setVerificationProgress(progress);
      if (progress >= 100) {
        clearInterval(timerRef.current!);
        triggerSOS();
      }
    }, 30);
  };

  const stopVerification = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setIsVerifying(false);
    setVerificationProgress(0);
  };

  const handleAcceptConsent = async () => {
    if (profile) {
      const updatedProfile = { ...profile, dataConsentAccepted: true };
      await setDoc(doc(db, 'users', profile.uid), updatedProfile);
      setProfile(updatedProfile);
      setShowConsent(false);
    }
  };

  const handleVerify2FA = async () => {
    if (twoFACode === '123456') {
      if (profile) {
        const updatedProfile = { ...profile, twoFAEnabled: true };
        await setDoc(doc(db, 'users', profile.uid), updatedProfile);
        setProfile(updatedProfile);
      }
      setShow2FA(false);
      speak("Identidad verificada correctamente.");
    } else {
      setError("Código incorrecto. Intente con 123456.");
    }
  };

  const triggerSOS = async () => {
    if (!profile || !user) return;

    setSosActive(true);
    setIsVerifying(false);
    
    const message = "Hola, estamos contactando a un ejecutivo para que tenga su atención. Lo llamaremos a la brevedad.";
    speak(message);

    // Get location
    let location = undefined;
    try {
      const pos = await new Promise<GeolocationPosition>((res, rej) => 
        navigator.geolocation.getCurrentPosition(res, rej)
      );
      location = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    } catch (e) {
      console.warn("Location access denied");
    }

    try {
      await addDoc(collection(db, 'sos_requests'), {
        seniorId: profile.uid,
        seniorName: profile.displayName,
        executiveId: profile.assignedExecutiveId || 'default_exec', // In a real app, this would be assigned
        timestamp: serverTimestamp(),
        status: 'pending',
        location
      });
    } catch (err) {
      console.error(err);
      setError("No se pudo enviar la alerta. Intente de nuevo.");
    }

    // Reset after 10 seconds
    setTimeout(() => setSosActive(false), 10000);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-stone-100 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-red-600"></div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-stone-100 flex flex-col items-center justify-center p-6 text-center">
        <div className="bg-white p-8 rounded-3xl shadow-xl max-w-md w-full border-2 border-stone-200">
          <div className="w-24 h-24 bg-[#009ba3] rounded-3xl flex items-center justify-center mx-auto mb-6 shadow-inner overflow-hidden">
            <div className="relative w-full h-full flex items-center justify-center">
              <span className="text-white text-5xl font-black italic">C</span>
              <div className="absolute right-4 w-4 h-4 bg-[#f0ca00] transform rotate-45 translate-x-1"></div>
            </div>
          </div>
          <h1 className="text-3xl font-bold text-stone-900 mb-2">CNSenior</h1>
          <p className="text-stone-600 mb-8 text-lg">Su conexión directa y segura con su plan de salud Consalud.</p>
          <button 
            onClick={handleLogin}
            className="w-full py-4 px-6 bg-[#009ba3] text-white rounded-2xl font-bold text-xl shadow-lg hover:bg-[#00868d] transition-colors flex items-center justify-center gap-3"
          >
            <UserIcon className="w-6 h-6" />
            Ingresar con Google
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900 font-sans pb-24">
      {/* Header */}
      <header className="bg-white border-b border-stone-200 p-4 flex justify-between items-center sticky top-0 z-10 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-[#009ba3] rounded-xl flex items-center justify-center overflow-hidden relative">
             <span className="text-white text-xl font-black italic">C</span>
             <div className="absolute right-1 w-2 h-2 bg-[#f0ca00] transform rotate-45 translate-x-0.5"></div>
          </div>
          <span className="font-bold text-xl tracking-tight">CNSenior</span>
        </div>
        <button 
          onClick={handleLogout}
          className="p-2 text-stone-500 hover:text-red-600 transition-colors"
          title="Cerrar sesión"
        >
          <LogOut className="w-6 h-6" />
        </button>
      </header>

      <main className="max-w-2xl mx-auto p-6">
        {/* Success Toast */}
        <AnimatePresence>
          {successMessage && (
            <motion.div 
              initial={{ opacity: 0, y: -50 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -50 }}
              className="fixed top-20 left-1/2 -translate-x-1/2 z-50 bg-emerald-600 text-white px-6 py-3 rounded-2xl shadow-xl flex items-center gap-3 font-bold"
            >
              <CheckCircle2 className="w-6 h-6" />
              {successMessage}
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence mode="wait">
          {currentView === 'sos' && (
            <motion.div 
              key="sos"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
            >
              <div className="mb-8">
                <h2 className="text-2xl font-bold mb-1">Hola, {profile?.displayName.split(' ')[0]}</h2>
                <p className="text-stone-500 text-lg">¿En qué podemos ayudarle hoy?</p>
              </div>

              {/* SOS Button Section */}
              <div className="flex flex-col items-center justify-center py-4">
                <div className="relative">
                  <AnimatePresence>
                    {isVerifying && (
                      <motion.div 
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.8 }}
                        className="absolute inset-0 -m-4 rounded-full border-4 border-red-600 border-t-transparent animate-spin"
                      />
                    )}
                  </AnimatePresence>

                  <motion.button
                    onMouseDown={startVerification}
                    onMouseUp={stopVerification}
                    onMouseLeave={stopVerification}
                    onTouchStart={startVerification}
                    onTouchEnd={stopVerification}
                    animate={sosActive ? { scale: [1, 1.1, 1], rotate: [0, 5, -5, 0] } : {}}
                    transition={sosActive ? { repeat: Infinity, duration: 0.5 } : {}}
                    className={cn(
                      "w-56 h-56 rounded-full flex flex-col items-center justify-center shadow-2xl transition-all relative overflow-hidden active:scale-95",
                      sosActive ? "bg-emerald-500" : "bg-red-600"
                    )}
                  >
                    {/* Progress Overlay */}
                    {isVerifying && (
                      <div 
                        className="absolute bottom-0 left-0 w-full bg-red-800/50 transition-all"
                        style={{ height: `${verificationProgress}%` }}
                      />
                    )}

                    <div className="relative z-10 flex flex-col items-center">
                      {sosActive ? (
                        <>
                          <CheckCircle2 className="w-20 h-20 text-white mb-2" />
                          <span className="text-white font-black text-xl">AVISADO</span>
                        </>
                      ) : isVerifying ? (
                        <>
                          <Fingerprint className="w-20 h-20 text-white mb-2 animate-pulse" />
                          <span className="text-white font-bold text-base">VERIFICANDO...</span>
                        </>
                      ) : (
                        <>
                          <AlertCircle className="w-20 h-20 text-white mb-2" />
                          <span className="text-white font-black text-3xl">BOTÓN</span>
                          <span className="text-white font-black text-3xl">SOS</span>
                        </>
                      )}
                    </div>
                  </motion.button>
                </div>

                <p className="mt-4 text-center text-stone-600 text-lg font-medium max-w-xs">
                  {sosActive 
                    ? "Un ejecutivo se pondrá en contacto con usted en breve."
                    : "Mantenga presionado el botón para solicitar atención inmediata."}
                </p>

                {/* Security Status Badges */}
                <div className="mt-4 grid grid-cols-2 gap-3 w-full max-w-sm px-2">
                  {/* Quick Consent Status Badge */}
                  <button 
                    onClick={profile?.dataConsentAccepted ? resetConsent : () => setShowConsent(true)}
                    className={cn(
                      "flex items-center justify-center gap-2 p-3 rounded-2xl border transition-all shadow-sm h-full",
                      profile?.dataConsentAccepted 
                        ? "bg-emerald-50 border-emerald-200 text-emerald-700" 
                        : "bg-red-50 border-red-200 text-red-700 animate-pulse"
                    )}
                  >
                    <ShieldCheck className="w-5 h-5 shrink-0" />
                    <div className="text-left">
                      <p className="text-[9px] font-bold uppercase tracking-wider leading-none opacity-70">Consentimientos</p>
                      <p className="text-xs font-bold whitespace-nowrap">{profile?.dataConsentAccepted ? "Otorgado" : "Pendiente"}</p>
                    </div>
                  </button>

                  {/* 2FA Status Badge */}
                  <button 
                    onClick={profile?.twoFAEnabled ? resetTwoFA : () => setShow2FA(true)}
                    className={cn(
                      "flex items-center justify-center gap-2 p-3 rounded-2xl border transition-all shadow-sm h-full",
                      profile?.twoFAEnabled 
                        ? "bg-emerald-50 border-emerald-200 text-emerald-700" 
                        : "bg-red-50 border-red-200 text-red-700 animate-pulse"
                    )}
                  >
                    <Fingerprint className="w-5 h-5 shrink-0" />
                    <div className="text-left">
                      <p className="text-[9px] font-bold uppercase tracking-wider leading-none opacity-70">Doble Factor</p>
                      <p className="text-xs font-bold whitespace-nowrap">{profile?.twoFAEnabled ? "Creado" : "Pendiente"}</p>
                    </div>
                  </button>
                </div>
              </div>

              {/* Recent Activity */}
              <div className="mt-12">
                <h3 className="text-xl font-bold mb-4 flex items-center gap-2">
                  <Clock className="w-5 h-5 text-stone-400" />
                  Actividad Reciente
                </h3>
                <div className="space-y-4">
                  {requests.length === 0 ? (
                    <div className="bg-white p-6 rounded-2xl border border-stone-200 text-center text-stone-400">
                      No hay solicitudes recientes.
                    </div>
                  ) : (
                    requests.map((req) => (
                      <div key={req.id} className="bg-white p-4 rounded-2xl border border-stone-200 shadow-sm flex items-center justify-between">
                        <div className="flex items-center gap-4">
                          <div className={cn(
                            "w-12 h-12 rounded-full flex items-center justify-center",
                            req.status === 'pending' ? "bg-amber-100 text-amber-600" : "bg-emerald-100 text-emerald-600"
                          )}>
                            <Phone className="w-6 h-6" />
                          </div>
                          <div>
                            <p className="font-bold">Llamada de Salud</p>
                            <p className="text-sm text-stone-500">
                              {req.timestamp?.toDate().toLocaleString() || 'Enviando...'}
                            </p>
                          </div>
                        </div>
                        <span className={cn(
                          "px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider",
                          req.status === 'pending' ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"
                        )}>
                          {req.status === 'pending' ? 'Pendiente' : 'Atendido'}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {currentView === 'profile' && (
            <motion.div 
              key="profile"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="space-y-6"
            >
              <h2 className="text-3xl font-bold">Mi Perfil</h2>
              
              <div className="bg-white p-6 rounded-3xl border border-stone-200 shadow-sm space-y-6">
                {/* RUT Field */}
                <div>
                  <label className={cn(
                    "text-sm font-bold uppercase tracking-wider",
                    isEditingProfile && (!validateRut(editData.rut || '') || editData.rut !== profile?.rut) ? "text-red-500" : "text-stone-400"
                  )}>
                    RUT / Identificación *
                  </label>
                  <div className="mt-1">
                    {isEditingProfile ? (
                      <>
                        <input 
                          type="text" 
                          placeholder="12.345.678-9"
                          value={editData.rut || ''}
                          onChange={(e) => setEditData(prev => ({ ...prev, rut: formatRut(e.target.value) }))}
                          className={cn(
                            "w-full p-4 bg-stone-100 rounded-xl font-bold text-lg border-2 transition-all focus:ring-2 focus:ring-violet-500",
                            !validateRut(editData.rut || '') ? "border-red-200 bg-red-50 focus:ring-red-500" : "border-transparent",
                            editData.rut !== profile?.rut && validateRut(editData.rut || '') && "border-emerald-200 bg-emerald-50"
                          )}
                        />
                        {!validateRut(editData.rut || '') && editData.rut && (
                          <motion.div initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-2 mt-2 p-3 bg-red-100/50 border border-red-200 rounded-xl text-red-700 text-xs font-bold">
                            <AlertCircle className="w-4 h-4 shrink-0" />
                            <span>El RUT ingresado no es válido o está incompleto.</span>
                          </motion.div>
                        )}
                      </>
                    ) : (
                      <div className="w-full p-4 bg-stone-50 rounded-xl font-bold text-lg">
                        {profile?.rut || 'No cargado *'}
                      </div>
                    )}
                  </div>
                </div>

                {/* Name Field */}
                <div>
                  <label className={cn(
                    "text-sm font-bold uppercase tracking-wider",
                    isEditingProfile && (!validateName(editData.displayName || '') || editData.displayName !== profile?.displayName) ? "text-red-500" : "text-stone-400"
                  )}>
                    Nombre Completo *
                  </label>
                  <div className="mt-1">
                    {isEditingProfile ? (
                      <>
                        <input 
                          type="text"
                          value={editData.displayName || ''}
                          onChange={(e) => setEditData(prev => ({ ...prev, displayName: e.target.value }))}
                          className={cn(
                            "w-full p-4 bg-stone-100 rounded-xl font-bold text-lg border-2 transition-all focus:ring-2 focus:ring-violet-500",
                            !validateName(editData.displayName || '') && editData.displayName ? "border-red-200 bg-red-50 focus:ring-red-500" : "border-transparent",
                            editData.displayName !== profile?.displayName && validateName(editData.displayName || '') && "border-emerald-200 bg-emerald-50"
                          )}
                        />
                        {!validateName(editData.displayName || '') && editData.displayName && (
                          <motion.div initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-2 mt-2 p-3 bg-red-100/50 border border-red-200 rounded-xl text-red-700 text-xs font-bold">
                            <AlertCircle className="w-4 h-4 shrink-0" />
                            <span>El nombre solo puede contener letras y espacios.</span>
                          </motion.div>
                        )}
                      </>
                    ) : (
                      <div className="w-full p-4 bg-stone-50 rounded-xl font-bold text-lg">
                        {profile?.displayName || 'No cargado *'}
                      </div>
                    )}
                  </div>
                </div>

                {/* Phone Field */}
                <div>
                  <label className={cn(
                    "text-sm font-bold uppercase tracking-wider",
                    isEditingProfile && (!validatePhone(editData.phoneNumber || '') || editData.phoneNumber !== profile?.phoneNumber) ? "text-red-500" : "text-stone-400"
                  )}>
                    Número de Teléfono *
                  </label>
                  <div className="mt-1">
                    {isEditingProfile ? (
                      <>
                        <div className={cn(
                          "flex items-center bg-stone-100 rounded-xl overflow-hidden border-2 transition-all",
                          !validatePhone(editData.phoneNumber || '') && editData.phoneNumber ? "border-red-200 bg-red-50" : "border-transparent",
                          editData.phoneNumber !== profile?.phoneNumber && validatePhone(editData.phoneNumber || '') && "border-emerald-200 bg-emerald-50"
                        )}>
                          <span className="pl-4 font-bold text-lg text-stone-500">+56</span>
                          <input 
                            type="tel"
                            maxLength={8}
                            value={editData.phoneNumber || ''}
                            onChange={(e) => setEditData(prev => ({ ...prev, phoneNumber: e.target.value.replace(/\D/g, '') }))}
                            className="flex-1 p-4 bg-transparent font-bold text-lg border-none focus:ring-0"
                          />
                        </div>
                        {!validatePhone(editData.phoneNumber || '') && editData.phoneNumber && (
                          <motion.div initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-2 mt-2 p-3 bg-red-100/50 border border-red-200 rounded-xl text-red-700 text-xs font-bold">
                            <AlertCircle className="w-4 h-4 shrink-0" />
                            <span>Debe ingresar exactamente 8 dígitos numéricos.</span>
                          </motion.div>
                        )}
                      </>
                    ) : (
                      <div className="w-full p-4 bg-stone-50 rounded-xl font-bold text-lg">
                        {profile?.phoneNumber ? `+56 ${profile.phoneNumber}` : 'No cargado *'}
                      </div>
                    )}
                  </div>
                </div>

                {/* Health Plan Field */}
                <div>
                  <label className={cn(
                    "text-sm font-bold uppercase tracking-wider",
                    isEditingProfile && (!validatePlan(editData.healthPlan || '') || editData.healthPlan !== profile?.healthPlan) ? "text-red-500" : "text-stone-400"
                  )}>
                    Plan de Salud *
                  </label>
                  <div className="mt-1">
                    {isEditingProfile ? (
                      <>
                        <input 
                          type="text"
                          maxLength={50}
                          placeholder="Ej: Fonasa B, Isapre Banmédica"
                          value={editData.healthPlan || ''}
                          onChange={(e) => setEditData(prev => ({ ...prev, healthPlan: e.target.value }))}
                          className={cn(
                            "w-full p-4 bg-stone-100 rounded-xl font-bold text-lg border-2 transition-all focus:ring-2 focus:ring-violet-500",
                            !validatePlan(editData.healthPlan || '') && editData.healthPlan ? "border-red-200 bg-red-50 focus:ring-red-500" : "border-transparent",
                            editData.healthPlan !== profile?.healthPlan && validatePlan(editData.healthPlan || '') && "border-emerald-200 bg-emerald-50"
                          )}
                        />
                        {!validatePlan(editData.healthPlan || '') && editData.healthPlan && (
                          <motion.div initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-2 mt-2 p-3 bg-red-100/50 border border-red-200 rounded-xl text-red-700 text-xs font-bold">
                            <AlertCircle className="w-4 h-4 shrink-0" />
                            <span>El plan debe ser alfanumérico y tener entre 3 y 50 caracteres.</span>
                          </motion.div>
                        )}
                        {isEditingProfile && !editData.healthPlan && (
                          <motion.div initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-2 mt-2 p-3 bg-red-100/50 border border-red-200 rounded-xl text-red-700 text-xs font-bold">
                            <AlertCircle className="w-4 h-4 shrink-0" />
                            <span>Este campo es obligatorio.</span>
                          </motion.div>
                        )}
                      </>
                    ) : (
                      <div className="w-full p-4 bg-stone-50 rounded-xl font-bold text-lg text-violet-600">
                        {profile?.healthPlan || 'No cargado *'}
                      </div>
                    )}
                  </div>
                </div>

                {/* Address Section */}
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
                    <div className="md:col-span-6">
                      <label className={cn(
                        "text-sm font-bold uppercase tracking-wider",
                        isEditingProfile && (!validateAddress(editData.address || '') || editData.address !== profile?.address) ? "text-red-500" : "text-stone-400"
                      )}>
                        Dirección *
                      </label>
                      <div className="mt-1">
                        {isEditingProfile ? (
                          <>
                            <input 
                              type="text"
                              maxLength={50}
                              placeholder="Calle / Avenida"
                              value={editData.address || ''}
                              onChange={(e) => setEditData(prev => ({ ...prev, address: e.target.value }))}
                              className={cn(
                                "w-full p-4 bg-stone-100 rounded-xl font-bold text-lg border-2 transition-all focus:ring-2 focus:ring-violet-500",
                                !validateAddress(editData.address || '') && editData.address ? "border-red-200 bg-red-50 focus:ring-red-500" : "border-transparent",
                                editData.address !== profile?.address && validateAddress(editData.address || '') && "border-emerald-200 bg-emerald-50"
                              )}
                            />
                          </>
                        ) : (
                          <div className="w-full p-4 bg-stone-50 rounded-xl font-bold text-lg">
                            {profile?.address || 'No cargada *'}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="md:col-span-3">
                      <label className={cn(
                        "text-sm font-bold uppercase tracking-wider",
                        isEditingProfile && (!validateAddressNumber(editData.addressNumber || '') || editData.addressNumber !== profile?.addressNumber) ? "text-red-500" : "text-stone-400"
                      )}>
                        Número *
                      </label>
                      <div className="mt-1">
                        {isEditingProfile ? (
                          <input 
                            type="text"
                            maxLength={10}
                            placeholder="Ej: 1234"
                            value={editData.addressNumber || ''}
                            onChange={(e) => setEditData(prev => ({ ...prev, addressNumber: e.target.value.replace(/\D/g, '') }))}
                            className={cn(
                              "w-full p-4 bg-stone-100 rounded-xl font-bold text-lg border-2 transition-all focus:ring-2 focus:ring-violet-500",
                              !validateAddressNumber(editData.addressNumber || '') && editData.addressNumber ? "border-red-200 bg-red-50 focus:ring-red-500" : "border-transparent",
                              editData.addressNumber !== profile?.addressNumber && validateAddressNumber(editData.addressNumber || '') && "border-emerald-200 bg-emerald-50"
                            )}
                          />
                        ) : (
                          <div className="w-full p-4 bg-stone-50 rounded-xl font-bold text-lg">
                            {profile?.addressNumber || 'S/N'}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="md:col-span-3">
                      <label className={cn(
                        "text-sm font-bold uppercase tracking-wider",
                        isEditingProfile && editData.apartment !== profile?.apartment ? "text-violet-500" : "text-stone-400"
                      )}>
                        Dpto/Oficina
                      </label>
                      <div className="mt-1">
                        {isEditingProfile ? (
                          <input 
                            type="text"
                            maxLength={20}
                            placeholder="Opcional"
                            value={editData.apartment || ''}
                            onChange={(e) => setEditData(prev => ({ ...prev, apartment: e.target.value }))}
                            className={cn(
                              "w-full p-4 bg-stone-100 rounded-xl font-bold text-lg border-2 transition-all focus:ring-2 focus:ring-violet-500",
                              editData.apartment !== profile?.apartment ? "border-violet-200 bg-violet-50" : "border-transparent"
                            )}
                          />
                        ) : (
                          <div className="w-full p-4 bg-stone-50 rounded-xl font-bold text-lg">
                            {profile?.apartment || '-'}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Address Alerts */}
                  {isEditingProfile && (
                    <div className="space-y-2">
                      {!validateAddress(editData.address || '') && editData.address && (
                        <motion.div initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-2 p-3 bg-red-100/50 border border-red-200 rounded-xl text-red-700 text-xs font-bold">
                          <AlertCircle className="w-4 h-4 shrink-0" />
                          <span>La dirección debe tener al menos 10 caracteres.</span>
                        </motion.div>
                      )}
                      {!validateAddressNumber(editData.addressNumber || '') && editData.addressNumber && (
                        <motion.div initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-2 p-3 bg-red-100/50 border border-red-200 rounded-xl text-red-700 text-xs font-bold">
                          <AlertCircle className="w-4 h-4 shrink-0" />
                          <span>El número debe ser numérico.</span>
                        </motion.div>
                      )}
                      {(!editData.address || !editData.addressNumber) && (
                        <motion.div initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-2 p-3 bg-red-100/50 border border-red-200 rounded-xl text-red-700 text-xs font-bold">
                          <AlertCircle className="w-4 h-4 shrink-0" />
                          <span>Dirección y Número son obligatorios.</span>
                        </motion.div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Buttons Relocated */}
              <div className="grid grid-cols-1 gap-4">
                <button 
                  onClick={toggleEditingProfile}
                  className={cn(
                    "flex items-center justify-center gap-4 p-6 rounded-3xl border-2 transition-all shadow-sm group",
                    isEditingProfile 
                      ? "bg-stone-50 border-stone-200 text-stone-600" 
                      : "bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100"
                  )}
                >
                  <Edit2 className="w-8 h-8 shrink-0 group-hover:scale-110 transition-transform" />
                  <div className="text-left">
                    <p className="text-xs font-bold uppercase tracking-widest opacity-60">Perfil</p>
                    <p className="text-xl font-black">{isEditingProfile ? "Cancelar Edición" : "Editar Perfil"}</p>
                  </div>
                </button>

                <button 
                  onClick={handleSaveProfile}
                  disabled={!isEditingProfile || !isProfileValid()}
                  className={cn(
                    "flex items-center justify-center gap-4 p-6 rounded-3xl border-2 transition-all shadow-sm group",
                    isEditingProfile && isProfileValid()
                      ? "bg-violet-50 border-violet-200 text-violet-700 hover:bg-violet-100" 
                      : "bg-stone-50 border-stone-100 text-stone-400 opacity-50 cursor-not-allowed"
                  )}
                >
                  <Save className="w-8 h-8 shrink-0 group-hover:scale-110 transition-transform" />
                  <div className="text-left">
                    <p className="text-xs font-bold uppercase tracking-widest opacity-60">Datos</p>
                    <p className="text-xl font-black">Guardar Cambios</p>
                  </div>
                </button>
              </div>


              <div className="bg-amber-50 p-6 rounded-3xl border border-amber-200 flex items-start gap-4">
                <AlertCircle className="w-8 h-8 text-amber-600 shrink-0" />
                <p className="text-amber-800 font-medium">
                  Sus datos están protegidos bajo la Ley de Protección de Datos Personales.
                </p>
              </div>
            </motion.div>
          )}

          {currentView === 'sedes' && (
            <motion.div 
              key="sedes"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-6"
            >
              <h2 className="text-3xl font-bold">Sedes Cercanas</h2>
              <p className="text-stone-500 text-lg">Seleccione la oficina de Consalud más cercana.</p>
              
              <AnimatePresence>
                {showMap && selectedOfficeId ? (
                  <motion.div 
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className="relative bg-stone-200 rounded-3xl h-80 overflow-hidden shadow-inner border-2 border-stone-300 z-10"
                  >
                    <MapContainer 
                      center={[
                        nearbyOffices.find(o => o.id === selectedOfficeId)?.lat || -33.4489, 
                        nearbyOffices.find(o => o.id === selectedOfficeId)?.lng || -70.6693
                      ]} 
                      zoom={15} 
                      style={{ height: '100%', width: '100%' }}
                      zoomControl={false}
                    >
                      <TileLayer
                        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                      />
                      <ChangeView center={[
                        nearbyOffices.find(o => o.id === selectedOfficeId)?.lat || -33.4489, 
                        nearbyOffices.find(o => o.id === selectedOfficeId)?.lng || -70.6693
                      ]} />
                      <Marker 
                        position={[
                          nearbyOffices.find(o => o.id === selectedOfficeId)?.lat || -33.4489, 
                          nearbyOffices.find(o => o.id === selectedOfficeId)?.lng || -70.6693
                        ]}
                        icon={redIcon}
                      >
                        <Popup>
                          <div className="p-1">
                            <p className="font-bold">{nearbyOffices.find(o => o.id === selectedOfficeId)?.name}</p>
                            <p className="text-xs">{nearbyOffices.find(o => o.id === selectedOfficeId)?.address}</p>
                          </div>
                        </Popup>
                      </Marker>
                    </MapContainer>
                    
                    {/* Map Controls Overlay */}
                    <div className="absolute top-4 right-4 flex flex-col gap-2 z-[1000]">
                      <button onClick={() => setShowMap(false)} className="bg-white p-2 rounded-xl shadow-lg text-stone-600 hover:bg-stone-50 transition-colors">
                        <X className="w-5 h-5" />
                      </button>
                    </div>

                    <div className="absolute bottom-4 left-4 right-4 bg-white/90 backdrop-blur-sm p-3 rounded-2xl shadow-lg z-[1000]">
                      <p className="font-bold text-sm">{nearbyOffices.find(o => o.id === selectedOfficeId)?.name}</p>
                      <p className="text-xs text-stone-500">{nearbyOffices.find(o => o.id === selectedOfficeId)?.address}</p>
                    </div>
                  </motion.div>
                ) : (
                  <div className="space-y-4">
                    {nearbyOffices.map((office) => (
                      <div 
                        key={office.id} 
                        onClick={() => {
                          setSelectedOfficeId(office.id);
                          setShowMap(false);
                        }}
                        className={cn(
                          "bg-white p-6 rounded-3xl border shadow-sm flex items-center justify-between group transition-all cursor-pointer",
                          selectedOfficeId === office.id ? "border-emerald-500 bg-emerald-50 ring-2 ring-emerald-200" : "border-stone-200"
                        )}
                      >
                        <div className="flex items-center gap-4">
                          <div className={cn(
                            "w-14 h-14 rounded-2xl flex items-center justify-center transition-colors",
                            selectedOfficeId === office.id ? "bg-emerald-600 text-white" : "bg-emerald-100 text-emerald-600"
                          )}>
                            <MapPin className="w-8 h-8" />
                          </div>
                          <div>
                            <p className="font-bold text-xl">{office.name}</p>
                            <p className="text-stone-500">{office.address}</p>
                          </div>
                        </div>
                        {selectedOfficeId === office.id && (
                          <CheckCircle2 className="w-8 h-8 text-emerald-600" />
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </AnimatePresence>

              {!showMap && (
                <button 
                  onClick={() => setShowMap(true)}
                  disabled={!selectedOfficeId}
                  className={cn(
                    "w-full py-6 text-white rounded-3xl font-bold text-xl shadow-xl flex items-center justify-center gap-3 transition-all",
                    selectedOfficeId ? "bg-emerald-600 opacity-100" : "bg-stone-300 opacity-50"
                  )}
                >
                  <MapPin className="w-6 h-6" />
                  Ver en el Mapa
                </button>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Modals */}
      <AnimatePresence>
        {showConsentConfirm && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-6">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="bg-white rounded-3xl p-8 max-w-sm w-full shadow-2xl relative"
            >
              <button 
                onClick={() => setShowConsentConfirm(false)}
                className="absolute top-4 right-4 p-2 text-stone-400 hover:text-stone-600 transition-colors"
              >
                <X className="w-6 h-6" />
              </button>
              
              <AlertCircle className="w-16 h-16 text-amber-500 mb-6" />
              <h3 className="text-2xl font-bold mb-4">¿Reiniciar Consentimiento?</h3>
              <p className="text-stone-600 mb-8 leading-relaxed">
                Ya ha otorgado su consentimiento para el tratamiento de datos. ¿Desea revocarlo y volver a revisar los términos?
              </p>
              <div className="flex flex-col gap-3">
                <button 
                  onClick={confirmResetConsent}
                  className="w-full py-4 bg-red-600 text-white rounded-2xl font-bold text-lg shadow-lg"
                >
                  Sí, reiniciar
                </button>
                <button 
                  onClick={() => setShowConsentConfirm(false)}
                  className="w-full py-4 bg-stone-100 text-stone-600 rounded-2xl font-bold text-lg"
                >
                  Cancelar
                </button>
              </div>
            </motion.div>
          </div>
        )}

        {showConsent && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-6">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="bg-white rounded-3xl p-8 max-w-sm w-full shadow-2xl relative"
            >
              <button 
                onClick={() => {
                  setShowConsent(false);
                  setHasDismissedConsent(true);
                }}
                className="absolute top-4 right-4 p-2 text-stone-400 hover:text-stone-600 transition-colors"
              >
                <X className="w-6 h-6" />
              </button>
              
              <ShieldCheck className="w-16 h-16 text-[#009ba3] mb-6" />
              <h3 className="text-2xl font-bold mb-4">Consentimiento de Datos</h3>
              <p className="text-stone-600 mb-8 leading-relaxed">
                De acuerdo con la Ley de Protección de Datos Personales en Chile, solicitamos su consentimiento para tratar sus datos de salud con el fin de brindarle una atención urgente y personalizada.
              </p>
              <button 
                onClick={handleAcceptConsent}
                className="w-full py-4 bg-[#009ba3] text-white rounded-2xl font-bold text-lg shadow-lg"
              >
                Acepto los términos
              </button>
            </motion.div>
          </div>
        )}

        {show2FAConfirm && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-6">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="bg-white rounded-3xl p-8 max-w-sm w-full shadow-2xl relative"
            >
              <button 
                onClick={() => setShow2FAConfirm(false)}
                className="absolute top-4 right-4 p-2 text-stone-400 hover:text-stone-600 transition-colors"
              >
                <X className="w-6 h-6" />
              </button>
              
              <AlertCircle className="w-16 h-16 text-amber-500 mb-6" />
              <h3 className="text-2xl font-bold mb-4">¿Reiniciar Doble Factor?</h3>
              <p className="text-stone-600 mb-8 leading-relaxed">
                Ya tiene activada la verificación de dos pasos. ¿Desea desactivarla y configurar un nuevo dispositivo?
              </p>
              <div className="flex flex-col gap-3">
                <button 
                  onClick={confirmResetTwoFA}
                  className="w-full py-4 bg-red-600 text-white rounded-2xl font-bold text-lg shadow-lg"
                >
                  Sí, reiniciar
                </button>
                <button 
                  onClick={() => setShow2FAConfirm(false)}
                  className="w-full py-4 bg-stone-100 text-stone-600 rounded-2xl font-bold text-lg"
                >
                  Cancelar
                </button>
              </div>
            </motion.div>
          </div>
        )}

        {show2FA && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-6">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="bg-white rounded-3xl p-8 max-w-sm w-full shadow-2xl relative overflow-y-auto max-h-[90vh]"
            >
              <button 
                onClick={() => setShow2FA(false)}
                className="absolute top-4 right-4 p-2 text-stone-400 hover:text-stone-600 transition-colors"
              >
                <X className="w-6 h-6" />
              </button>
              
              <Fingerprint className="w-16 h-16 text-violet-600 mb-6" />
              <h3 className="text-2xl font-bold mb-4">Configurar Doble Factor</h3>
              
              <div className="bg-stone-50 p-6 rounded-2xl mb-6 flex flex-col items-center">
                <p className="text-xs text-stone-500 mb-4 text-center">Escanee este código en Google Authenticator</p>
                <div className="bg-white p-4 rounded-xl shadow-inner mb-4">
                  <QRCodeSVG 
                    value={`otpauth://totp/CNSenior:${profile?.email}?secret=${twoFASecret || 'MOCKSECRET'}&issuer=CNSenior`}
                    size={160}
                  />
                </div>
                <p className="text-[10px] font-mono text-stone-400 break-all text-center">Secret: {twoFASecret || 'MOCKSECRET'}</p>
              </div>

              <p className="text-stone-600 mb-4 text-sm">
                Ingrese el código de 6 dígitos generado por su aplicación:
              </p>
              <input 
                type="text"
                maxLength={6}
                placeholder="000000"
                className={cn(
                  "w-full p-4 bg-stone-100 rounded-xl text-center text-3xl font-black tracking-[0.5em] mb-2 border-none focus:ring-2 focus:ring-violet-500",
                  error?.includes("incorrecto") && "ring-2 ring-red-500 bg-red-50"
                )}
                value={twoFACode}
                onChange={(e) => setTwoFACode(e.target.value)}
              />
              
              {error?.includes("incorrecto") && (
                <p className="text-red-600 text-xs font-bold mb-4 text-center animate-bounce">
                  Código incorrecto. Intente con 123456
                </p>
              )}

              <button 
                onClick={handleVerify2FA}
                className="w-full py-4 bg-violet-600 text-white rounded-2xl font-bold text-lg shadow-lg"
              >
                Verificar y Activar
              </button>
              <p className="mt-4 text-center text-xs text-stone-400">Pruebe con: 123456</p>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Footer Nav */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-stone-200 p-3 flex justify-around items-center shadow-2xl z-20">
        <button 
          onClick={() => setCurrentView('sos')}
          className={cn(
            "flex flex-col items-center p-2 transition-all",
            currentView === 'sos' ? "text-red-600 scale-110" : "text-stone-400"
          )}
        >
          <AlertCircle className="w-8 h-8" />
          <span className="text-xs font-bold mt-1">SOS</span>
        </button>
        <button 
          onClick={() => setCurrentView('profile')}
          className={cn(
            "flex flex-col items-center p-2 transition-all",
            currentView === 'profile' ? "text-violet-600 scale-110" : "text-stone-400"
          )}
        >
          <UserIcon className="w-8 h-8" />
          <span className="text-xs font-bold mt-1">Perfil</span>
        </button>
        <button 
          onClick={() => setCurrentView('sedes')}
          className={cn(
            "flex flex-col items-center p-2 transition-all",
            currentView === 'sedes' ? "text-emerald-600 scale-110" : "text-stone-400"
          )}
        >
          <MapPin className="w-8 h-8" />
          <span className="text-xs font-bold mt-1">Sedes</span>
        </button>
      </nav>

      {/* Error Toast */}
      <AnimatePresence>
        {error && (
          <motion.div 
            initial={{ y: -100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -100, opacity: 0 }}
            className="fixed top-6 left-4 right-4 bg-red-600 text-white p-4 rounded-2xl shadow-2xl flex items-center justify-between z-[70]"
          >
            <span className="font-medium">{error}</span>
            <button onClick={() => setError(null)} className="font-bold underline">Cerrar</button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
