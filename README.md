# Meghu Holidays

## Run locally

Requires Node.js 22.13 or newer. Copy `.env.example` to `.env`, then replace
`ADMIN_API_KEY` with a private random secret of at least 32 characters. For
example, PowerShell can generate one with:

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

Start the website and API from this directory:

```powershell
npm start
```

Open <http://127.0.0.1:3000>. Booking requests are stored in
`data/bookings.sqlite`. Keep `.env` and the database private and backed up.

## API

`POST /api/bookings` accepts a JSON booking and saves it. Required fields:
`name`, `phone`, `pickup`, `dropoff`, `travelDate` (`YYYY-MM-DD`), `vehicle`
(`Urbania`, `Innova Crysta`, `Etios`, `Traveller`, or `Bus`), and `passengers`
(1–100). `message` is optional.

`GET /api/bookings?limit=50&offset=0` returns the newest bookings first. It
requires the admin key as a bearer token:

```powershell
$headers = @{ Authorization = "Bearer $env:ADMIN_API_KEY" }
Invoke-RestMethod "http://127.0.0.1:3000/api/bookings" -Headers $headers
```

The public booking route validates input and uses parameterized SQLite queries.
The bookings-list endpoint must only be used over HTTPS when deployed publicly.
