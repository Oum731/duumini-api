const { io } = require("socket.io-client");

const [tokenA, tokenB] = [process.argv[2], process.argv[3]];
const URL = "https://duumini-api.onrender.com/duoline";

const a = io(URL, { auth: { token: tokenA } });
const b = io(URL, { auth: { token: tokenB } });

let aConnected = false, bConnected = false;
const timer = setTimeout(() => { console.log("TIMEOUT"); process.exit(1); }, 15000);

function maybeSendOffer() {
  if (aConnected && bConnected) {
    console.log("Les deux connectés, A envoie call:offer...");
    a.emit("call:offer", { sdp: { type: "offer", sdp: "fake-sdp-for-test" }, callType: "audio" });
  }
}

a.on("connect", () => { console.log("A connecté", a.id); aConnected = true; maybeSendOffer(); });
b.on("connect", () => { console.log("B connecté", b.id); bConnected = true; maybeSendOffer(); });
a.on("connect_error", (e) => console.log("A connect_error", e.message));
b.on("connect_error", (e) => console.log("B connect_error", e.message));

b.on("call:offer", (payload) => {
  console.log("B a reçu call:offer !", JSON.stringify(payload));
  clearTimeout(timer);
  a.disconnect(); b.disconnect();
  process.exit(0);
});
