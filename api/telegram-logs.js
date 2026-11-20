async function logNotification(database, uid, entry) {
  const logsRef = database.ref(`users/${uid}/notificationLogs`);
  const logRef = logsRef.push();
  await logRef.set({
    ...entry,
    createdAt: Date.now()
  });

  const snapshot = await logsRef.orderByChild("createdAt").limitToLast(101).get();
  const oldest = Object.entries(snapshot.val() || {})
    .map(([id, log]) => ({ id, createdAt: Number(log.createdAt || 0) }))
    .sort((a, b) => a.createdAt - b.createdAt);
  if (oldest.length > 100) {
    await Promise.all(oldest.slice(0, oldest.length - 100).map(item =>
      logsRef.child(item.id).remove()
    ));
  }
}

module.exports = { logNotification };
