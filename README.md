# vendors.mycitadel.lol

> **The public asset delivery layer for MyCitadel. Fast. Cached. Isolated.**

`vendors.mycitadel.lol` is the dedicated static asset host for the MyCitadel platform. It serves all frontend vendor libraries — CSS frameworks, JavaScript libraries, icon fonts, and web fonts — from a single, cache-optimized origin.

[![Subdomain](https://img.shields.io/badge/subdomain-vendors.mycitadel.lol-blue)](https://vendors.mycitadel.lol)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Assets: Immutable](https://img.shields.io/badge/Cache-Immutable-green)](#-caching-strategy)

---

## 🎯 Why a Separate Subdomain?

We deliberately separated vendor assets from the main application. Here's why:

| Benefit | Explanation |
|---------|-------------|
| **Browser Caching** | Assets cached once, reused across `mycitadel.lol` and `api.mycitadel.lol` |
| **CDN-Ready** | Can be pointed at Cloudflare / BunnyCDN with zero code changes |
| **Isolation** | Vendor bugs, outdated libs, or compromises don't touch the app origin |
| **Independent Deploys** | Update libraries without redeploying the main site |
| **Tight Cache Headers** | Static-only origin can use `immutable` + long `max-age` safely |
| **Cleaner Repos** | Main `MyCitadel` repo shrinks to application code only |

---

## 📦 Hosted Libraries

All libraries are served as-is from their official distributions. **No modifications.**

### JavaScript & CSS Frameworks

| Library | Purpose | Path |
|---------|---------|------|
| **Bootstrap** | CSS/JS UI framework | `/Bootstrap/` |
| **ChartJS** | Data visualization / charts | `/ChartJS/` |
| **DOMPurify** | HTML sanitization (XSS defense) | `/DOMPurify/` |
| **Canvas-Confetti** | Celebration animations | `/Canvas-Confetti/` |

### Icon & Web Fonts

| Library | Purpose | Path |
|---------|---------|------|
| **FontAwesome** | Icon font + CSS | `/FontAwesome/` |
| **GoogleFonts** | Self-hosted WOFF2 web fonts | `/GoogleFonts/` |

> **Note:** GoogleFonts are self-hosted (no calls to `fonts.googleapis.com` or `fonts.gstatic.com`). This eliminates third-party tracking and improves privacy — a core MyCitadel principle.

### Font Families (Self-Hosted)

All fonts are WOFF2 format for maximum compression and browser support:

`Aldrich` · `Almendra` · `Audiowide` · `Cinzel` · `Cinzel_Decorative` · `Eagle_Lake` · `Exo_2` · `Fira_Code` · `Grenze_Gotisch` · `IBM_Plex_Mono` · `IBM_Plex_Sans` · `IM_Fell_English_SC` · `Inter` · `JetBrains_Mono` · `Jura` · `MedievalSharp` · `Metal_Mania` · `Michroma` · `Orbitron` · `Oxanium` · `Pirata_One` · `Quantico` · `Saira_Condensed` · `Share_Tech_Mono` · `Source_Code_Pro` · `Space_Grotesk` · `Space_Mono` · `Syncopate` · `Turret_Road` · `Uncial_Antiqua` · `Zen_Dots`

---

## 🚫 What Does NOT Belong Here

This is a **frontend-only** asset host. The following are explicitly **forbidden** on this subdomain:

- ❌ **PHP libraries** (`stripe-php`, Composer `vendor/`, etc.) → live in `secure_mycitadel.lol/vendor/`
- ❌ **Server-side code** (`.php`, `.env`, configs) → belongs in app repos
- ❌ **Secrets, keys, tokens** → belong in `secure_mycitadel.lol/keys/`
- ❌ **User data, uploads, avatars** → belong on the app origin
- ❌ **Database dumps, logs** → never web-accessible

If it can't be safely served to a browser as a static file, it doesn't go here.

---

## 🔧 Usage

### Referencing Assets

Always use **HTTPS** and the **full subdomain**:

```html
<!-- Bootstrap -->
<link rel="stylesheet" href="https://vendors.mycitadel.lol/Bootstrap/css/bootstrap.min.css">
<script src="https://vendors.mycitadel.lol/Bootstrap/js/bootstrap.bundle.min.js"></script>

<!-- FontAwesome -->
<link rel="stylesheet" href="https://vendors.mycitadel.lol/FontAwesome/css/all.min.css">

<!-- ChartJS -->
<script src="https://vendors.mycitadel.lol/ChartJS/chart.umd.min.js"></script>

<!-- DOMPurify -->
<script src="https://vendors.mycitadel.lol/DOMPurify/purify.min.js"></script>

<!-- Canvas-Confetti -->
<script src="https://vendors.mycitadel.lol/Canvas-Confetti/confetti.browser.min.js"></script>
```

### Custom Fonts (@font-face)
```
@font-face {
  font-family: 'Inter';
  src: url('https://vendors.mycitadel.lol/GoogleFonts/Inter/Inter-VariableFont_opsz,wght.woff2') format('woff2-variations');
  font-weight: 100 900;
  font-display: swap;
}
```

## 🌐 CORS Configuration
Because fonts are loaded **cross-origin** (from `mycitadel.lol` → `vendors.mycitadel.lol`), CORS headers are **mandatory** for font files. Without them, browsers will block font loading.

### Apache (`.htaccess`)

```
<IfModule mod_headers.c>
 <FilesMatch "\.(woff2?|ttf|otf|eot)$">
 Header set Access-Control-Allow-Origin "*"
 Header set Access-Control-Allow-Methods "GET, OPTIONS"
 Header set Timing-Allow-Origin "*"
 </FilesMatch>
</IfModule>
```
**Why `*`?** Font files are non-sensitive static assets. Locking them to specific origins adds complexity with zero security gain. If you prefer strict origins, replace `*` with an explicit list:

```
Header set Access-Control-Allow-Origin "https://mycitadel.lol"
Header add Access-Control-Allow-Origin "https://api.mycitadel.lol"
```
### Nginx

```
location ~* \.(woff2?|ttf|otf|eot)$ {
 add_header Access-Control-Allow-Origin "*";
 add_header Access-Control-Allow-Methods "GET, OPTIONS";
 add_header Timing-Allow-Origin "*";
}
```
* * * * *

🔒 Content Security Policy
--------------------------

The main application's CSP **must** whitelist this subdomain:

```
Content-Security-Policy:
 default-src 'self';
 font-src  'self' https://vendors.mycitadel.lol;
 style-src 'self' https://vendors.mycitadel.lol;
 script-src 'self' https://vendors.mycitadel.lol;
 img-src   'self' data: https://vendors.mycitadel.lol;
```
Forget this and **nothing will load.** 🚨

* * * * *

🛡️ Subresource Integrity (SRI)
-------------------------------

Since vendor assets originate from a domain you control, SRI is technically optional. **We still recommend it** for defense-in-depth.

```
<script
 src="https://vendors.mycitadel.lol/Bootstrap/js/bootstrap.bundle.min.js"
 integrity="sha384-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
 crossorigin="anonymous"></script>
```
To generate an SRI hash:

```
openssl dgst -sha384 -binary FILE.js | openssl base64 -A
```
* * * * *

⚡ Caching Strategy
------------------

Static assets on this subdomain are served with aggressive caching headers. Browsers will cache them for **one year**:

```
<FilesMatch "\.(css|js|woff2?|ttf|otf|eot|svg|png|jpg|jpeg|gif|ico)$">
 Header set Cache-Control "public, max-age=31536000, immutable"
</FilesMatch>
```
### Upgrading a Library

Because assets are cached forever, **you cannot overwrite a file** at the same path --- users will keep the old cached version. Two options:

**Option A --- Versioned Paths (recommended):**

```
/Bootstrap/5.3.3/css/bootstrap.min.css
/Bootstrap/5.4.0/css/bootstrap.min.css
```
**Option B --- Cache-Busting Query String:**

```
/Bootstrap/css/bootstrap.min.css?v=5.3.3
```
Option A is superior --- true immutability, no cache invalidation ever needed.

* * * * *

🚀 Deployment
-------------

This subdomain is a **static file host only.** No PHP, no runtime, no database.

### Recommended Server Config

-   **Web server:** Nginx (faster static delivery than Apache)

-   **Gzip/Brotli:** Enabled for CSS, JS, SVG

-   **HTTP/2 or HTTP/3:** Enabled

-   **TLS:** Required (HTTPS only --- no HTTP fallback)

-   **Wildcard cert:**  `*.mycitadel.lol` covers this subdomain automatically

### DNS

```
vendors.mycitadel.lol    CNAME    mycitadel.lol
```
Or an independent A record if hosted separately.

* * * * *

📜 Licensing Notice
-------------------

**These are third-party libraries.** Each retains its own license. We do not claim ownership.

| Library | License |
| --- | --- |
| Bootstrap | MIT |
| ChartJS | MIT |
| DOMPurify | Apache-2.0 / MPL-2.0 |
| Canvas-Confetti | ISC |
| FontAwesome | Free: CC BY 4.0 / SIL OFL 1.1 / MIT |
| Google Fonts | SIL Open Font License 1.1 |

See each library's directory for its `LICENSE` file. If you redistribute or modify these assets, **you must comply with their licenses.**

* * * * *

🔄 Maintenance
--------------

### Updating a Library

1.  Download the new official release.

2.  Place it in a **versioned directory** (do not overwrite existing versions).

3.  Update references in `MyCitadel` repo HTML templates.

4.  Regenerate SRI hashes if used.

5.  Commit and push.

6.  (Optional) Purge CDN cache if a CDN is in front.

### Adding a New Library

1.  Verify it's a **frontend, static** library (CSS/JS/font).

2.  Verify it's **not** server-side code.

3.  Check its license is compatible.

4.  Add to a new folder: `/LibraryName/`

5.  Update this README's **Hosted Libraries** table.

6.  Open a PR to the main `MyCitadel` repo referencing the new asset.

* * * * *

🤝 Contributing
---------------

This repo is part of the MyCitadel ecosystem. Contributions are welcome!

1.  Fork this repo.

2.  Add your library or update.

3.  Update the **Hosted Libraries** table above.

4.  Open a Pull Request.

For the main project, see the [MyCitadel Contributing Guidelines](https://github.com/BeardedVikingTX/MyCitadel/blob/main/CONTRIBUTING.md).

* * * * *

🔗 Links
--------

-   **Main Website:**  [https://mycitadel.lol](https://mycitadel.lol/)

-   **API:**  [https://api.mycitadel.lol](https://api.mycitadel.lol/)

-   **This Subdomain:**  [https://vendors.mycitadel.lol](https://vendors.mycitadel.lol/)

-   **Main Repo:**  [MyCitadel](https://github.com/BeardedVikingTX/MyCitadel)

-   **API Repo:**  [API_MyCitadel](https://github.com/BeardedVikingTX/API_MyCitadel)

-   **HackerOne:** (coming soon)

* * * * *

🙏 Acknowledgements
-------------------

-   Built with ❤️ by Bearded Viking and contributors.

-   Gratitude to the open-source maintainers of every library hosted here.

* * * * *

**vendors.mycitadel.lol** -- *Fast. Immutable. Isolated. Static-only.*