const { runBackup } = require('./backupService');

runBackup('manual-cli')
  .then((manifest) => {
    console.log('Backup completed:', manifest);
    process.exit(0);
  })
  .catch((err) => {
    console.error('Backup failed:', err);
    process.exit(1);
  });
