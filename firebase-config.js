// firebase-config.js
//
// Ya viene con las llaves del proyecto de Firebase "dictador-y-ultimatum-micro-1".
// Es seguro que estas llaves queden visibles en el código público del sitio:
// no son secretas, solo identifican a qué proyecto de Firebase conectarse.
// La seguridad real la dan las Reglas de Firestore (ver firestore.rules.txt) —
// recuerden pegarlas en Firebase Console antes de usar la app en clase.

export const firebaseConfig = {
  apiKey: "AIzaSyDg0USK55uG46nlLwv_NdbXoSjROC1TRLo",
  authDomain: "dictador-y-ultimatum-micro-1.firebaseapp.com",
  projectId: "dictador-y-ultimatum-micro-1",
  storageBucket: "dictador-y-ultimatum-micro-1.firebasestorage.app",
  messagingSenderId: "521420494619",
  appId: "1:521420494619:web:0b75184feb81af856a25be",
  measurementId: "G-BDTQ267L6Z",
};

// Los montos, el número de rondas y las reglas de cada ronda (Dictador vs.
// Ultimátum, marco de "dar" vs. "quitar", dinero ganado, etc.) NO se editan
// aquí — están todos juntos en matching-logic.js, en la constante ROUNDS,
// para que sea un solo lugar donde cambiar el guion completo del experimento.
