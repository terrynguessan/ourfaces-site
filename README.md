# OurFaces Website

Six-page Next.js App Router site for OurFaces Import & Export, LLC.

## Pages

- Home (`/`)
- Technology / Solutions (`/technology`)
- Business (`/business`)
- Insights (`/insights`)
- About (`/about`)
- Contact (`/contact`)

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Deployment

The project is structured for GitHub -> Vercel deployment.

## Contact form

The visual contact form is implemented with the approved public placeholder address `info@ourfaces.net`. It currently prepares a message using the visitor's default email client rather than using an unapproved third-party form service. When Zoho Mail is configured, the form can be connected to a server-side delivery method without changing the approved page design or wording.

## Home-page Earth visual

The Home hero uses NASA's Blue Marble satellite imagery as a remote background texture to create the approved slow-moving Earth visual. Source and credit:

- NASA/Goddard Space Flight Center Scientific Visualization Studio
- Blue Marble Next Generation data courtesy of Reto Stockli (NASA/GSFC) and NASA's Earth Observatory
- https://svs.gsfc.nasa.gov/2915/

The site honors `prefers-reduced-motion`; the Earth animation stops when reduced motion is requested.
