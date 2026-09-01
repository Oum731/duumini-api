// Vrai si un autre utilisateur (que excludeUserId) a un socket ouvert dans la room.
// Accepte soit un Server socket.io "racine" (qui délègue à sa namespace par
// défaut), soit directement une Namespace (ex: io.of("/duoline")) — les deux
// exposent .adapter/.sockets à des niveaux différents, donc on détecte.
function isPartnerOnline(io, room, excludeUserId) {
  const nsp = io.sockets && io.sockets.adapter ? io.sockets : io;
  const roomSet = nsp.adapter.rooms.get(room);
  if (!roomSet) return false;

  for (const socketId of roomSet) {
    const s = nsp.sockets.get(socketId);
    if (s?.user && s.user.id !== excludeUserId) return true;
  }
  return false;
}

module.exports = { isPartnerOnline };
