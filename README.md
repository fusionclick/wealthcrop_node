# 📦 BSE StAR MF v2.0 – NodeJS Wrapper (Official)

A secure, modular Node.js SDK to consume the **BSE StAR MF v2.0 APIs**, including encrypted payload support, token-based authentication, and full lifecycle methods for UCC, Order, Mandates, SxP, and Payment flows.

> 🔐 Fully aligned with BSE’s encryption, token, and webhook standards. Ideal for ISVs, Back Offices, and QA teams looking to build sandbox/prod integrations.

---

## 📁 Project Structure

```
BSE_StARMF_2.0_NodeJS_Wrapper/
├── auth/                  → Login API + Token caching
├── common/                → Encryption, Decryption, Logging helpers
├── config/                → AES keys, API base URLs, timeouts
├── modules/
│   ├── ucc/               → Add, Modify, List, Get UCC
│   ├── order/             → New, Update, Cancel, Get Order
│   ├── mandate/           → Register, Cancel, List Mandates
│   ├── sxp/               → Register SIP, Pause/Resume/Cancel
│   └── payment/           → Upload MIS, List Details
├── utils/                 → AES/PKCS7 encryption utils
├── test/                  → Postman-style examples per module
├── index.js               → Entry file (wrapper glue)
└── package.json
```

---

## 🚀 Installation

```bash
git clone https://github.com/your-org/bse-starmfv2-node-wrapper.git
cd bse-starmfv2-node-wrapper
npm install
```

---

## 🔧 Configuration

Set your keys and endpoint base in `config/config.js`:

```js
module.exports = {
  apiBaseUrl: "https://api.bseindia.com/v2/",
  aesKey: "8080808080808080",
  aesIV: "8080808080808080",
  credentials: {
    username: "BSE_USERNAME",
    password: "BSE_PASSWORD"
  }
};
```

---

## 🛠️ How to Use

You can use this Node.js wrapper in two ways:

---

### **Option 1: As an API Gateway (Postman/Frontend use)**

This mode runs a local Express server at `http://localhost:3000` and exposes endpoints for each BSE StAR MF 2.0 module.

#### ✅ Step-by-Step:
  
1. **Start the server**

```bash
node src
```

2. **Use Postman** to hit an endpoint (e.g., to Add UCC):

```
POST http://localhost:3000/api/ucc/add
```

**Headers:**
```json
Content-Type: application/json
```

**Body:**
```json
{
  "ClientCode": "123456",
  "PAN": "ABCDE1234F",
  "DOB": "1990-01-01",
  "...": "..."
}
```
##YOU CAN CHANGE THE REQUEST DATA IN THE DIRECTORY AS PER YOUR REQUIREMENT in /requestData  to test your payloads.
3. **View Response**

- Postman will show the decrypted BSE API response.
- The same response is also logged in the terminal (CMD).

---

### **Option 2: Use as SDK in Node Scripts (Backend Use)**

You can directly import the wrapper functions in any Node.js script and call the APIs without running a server.

#### ✅ Step-by-Step:

1. **Import Token Generator**

```js
const { getToken } = require("./auth/login");
```

2. **Generate Token**

```js
const token = await getToken();
console.log("Token:", token);
```

3. **Call a Module Function (e.g., Add UCC)**

```js
const { addNewUCC } = require("./modules/ucc/addNewUCC");
const payload = require("./test/ucc/add_ucc_payload.json");

const response = await addNewUCC(payload);
console.log("Response:", response);
```

---

### 📌 Example Script: `run_add_ucc.js`

```js
const { getToken } = require("./auth/login");
const { addNewUCC } = require("./modules/ucc/addNewUCC");
const payload = require("./test/ucc/add_ucc_payload.json");

(async () => {
  const token = await getToken();
  const response = await addNewUCC(payload);
  console.log("API Response:", response);
})();
```

This method is suitable for automation, cron jobs, or backend integration where you don't want to expose a server.

### 🔀 Available API Routes

| Module      | Method | URL                                | Description               |
|-------------|--------|-------------------------------------|---------------------------|
| UCC         | POST   | `/api/ucc/add`                      | Add New UCC               |
| Order       | POST   | `/api/order/new`                    | Place Order               |
| Mandate     | POST   | `/api/mandate/register`            | Register Mandate          |
| SxP         | POST   | `/api/sxp/register`                | Register SIP/STP/SWP      |
| Payment MIS | POST   | `/api/payment/upload-mis`          | Upload Payment MIS file   |

More routes are available in `src/routes/`.

---

### ⚙️ Configuration

Before running the server, ensure this file is updated:

**`config/config.js`:**

```js
module.exports = {
  apiBaseUrl: "https://api.bseindia.com/v2/",
  aesKey: "8080808080808080",
  aesIV: "8080808080808080",
  credentials: {
    username: "YourMemberCode",
    password: "YourPassword"
  }
};
```

### 1️⃣ Authenticate (Token Generator)

```js
const { getToken } = require('./auth/tokenService');
const token = await getToken();
```

### 2️⃣ Call Any API (e.g., Add UCC)

```js
const { addNewUCC } = require('./modules/ucc/addNewUCC');
const payload = require('./test/ucc/add_ucc_payload.json');

const response = await addNewUCC(payload);
console.log(response);
```

All modules expose functions in this format:  
`addNewUCC(payload)` → returns decrypted response JSON

---

## 🧪 Example Test Payloads

Inside `/test/` folder, you’ll find ready-made Postman-style payloads:
- `ucc/add_ucc_payload.json`
- `order/order_new_payload.json`
- `sxp/sxp_register_payload.json`
- `mandate/mandate_register_payload.json`

Update these with your member-specific details before running.

---

## 📤 AES + PKCS7 Encrypted Payloads

All payloads follow encryption specs:
- AES-128-CBC mode
- PKCS7 Padding
- UTF-8 charset
- Base64 encode output

Payloads are encrypted/decrypted using utilities in `/utils/encryptionUtils.js`

---

## 🌐 Environment Compatibility

- Works for both **sandbox** and **production** APIs.
- All requests use `Bearer <token>` header after authentication.
- Base URLs, keys, and token expiry can be configured centrally.

---

## 📣 Notes

- Encrypted payloads are 100% compatible with JSON requests.
- Follows StAR MF’s v2 architecture: nested object model, bearer auth, webhook-ready structure.

---

## 🧾 License

This project is proprietary to BSE Technologies / BSE Ltd. Use is permitted only for registered entities integrating with the BSE StAR MF 2.0 platform.
---


