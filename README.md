# dashesl

## Run the shared dashboard

Use Node.js 22.13 or newer, which includes the SQLite module used by the backend.
Set a private dashboard password of at least 12 characters, then start the app:

```sh
export DASHBOARD_PASSWORD='choose-a-long-private-password'
npm start
```

Open `http://localhost:3000` or deploy the Node service behind HTTPS. The server
serves the dashboard and its `/api/dashboard` endpoint from the same origin and
stores the single shared dataset in `data/dashboard.sqlite`. Keep that directory
on persistent storage when deploying or updating the app; do not use ephemeral
serverless storage. Set `DASHBOARD_DATA_DIR` to choose a different persistent
database directory, and `PORT` to change the listening port.

The first visit requires the shared dashboard password. The browser's existing
dashboard data is used to initialize an empty database. Existing browser-only
data is left untouched after initialization; if it differs from the shared
dataset, Settings offers a download so it can be retained before importing or
reconciling it. Backups remain available in Settings.

The app supports current Chrome, Edge, Firefox, Safari, and other modern
browsers. All browsers must open the same deployed dashboard URL. Browser
storage is used only for pending offline changes and old-data migration, not as
the shared source of truth. Unsynchronized changes are clearly reported and
can be downloaded; edits are protected from overwriting a newer shared revision.

Run the backend tests with `npm test`.