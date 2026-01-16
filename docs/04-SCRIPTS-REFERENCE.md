# 🔧 Scripts Reference - Flight Search Project

เอกสารอธิบาย scripts ทั้งหมดที่ใช้ในโปรเจค สำหรับ fetch ข้อมูล, import ข้อมูล และจัดการระบบ

---

## 📋 Table of Contents

1. [Data Fetching Scripts](#data-fetching-scripts)
2. [Data Import Scripts](#data-import-scripts)
3. [Data Generation Scripts](#data-generation-scripts)
4. [Maintenance Scripts](#maintenance-scripts)
5. [Testing Scripts](#testing-scripts)
6. [NPM Scripts Reference](#npm-scripts-reference)

---

## 🌐 Data Fetching Scripts

Scripts สำหรับดึงข้อมูลจาก External APIs และบันทึกเป็น CSV

The flight data ingestion process consists of **three main steps**:

1.  **Fetch flight data from Google using SerpAPI**
2.  **Convert the fetched data into CSV format**
3.  **Import the CSV data into the database**

Each step is intentionally separated to keep the pipeline easy to debug, maintain, and extend.

  

**1\. Fetch Flight Data (Google SERP API)**

We retrieve raw flight data from **Google Flights** via **SerpAPI**.

-   SerpAPI acts as a wrapper around Google Search results.
-   Flight search results (prices, airlines, routes, dates, etc.) are fetched programmatically.
-   The raw response is typically returned in **JSON format**.

This step is responsible **only for data collection**, not transformation or storage.

  

**2\. Convert Flight Data to CSV**

After fetching the flight data:

-   The raw JSON response is parsed.
-   Relevant flight fields (e.g., origin, destination, price, airline, dates, class, etc.) are extracted.
-   The cleaned and structured data is converted into a **CSV file**.

Why CSV?

-   Easy to inspect manually
-   Easy to re-import or reprocess
-   Decouples data fetching from database logic

At the end of this step, you should have a CSV file ready for import.

  

**3\. Import Flight Data into the Database**

Once the CSV file is ready, we load it into the database using the following command:

  

npm run import:flights

This command:

-   Reads the generated CSV file
-   Validates and normalizes the data
-   Inserts the records into the appropriate database tables

This step ensures:

-   Consistent database structure
-   Centralized storage for analysis and predictions
-   No direct dependency on external APIs during analysis

---

## 🔄 Maintenance Scripts

Scripts สำหรับจัดการและ sync ข้อมูล

### 5. validatePriceConsistency.ts

**Purpose:** ตรวจสอบความสอดคล้องของราคาในระบบ

**Location:** `backend/src/scripts/validatePriceConsistency.ts`

**Usage:**

```bash
cd backend
npm run validate:prices
```

**What it does:**
- ตรวจสอบความสอดคล้องของราคาใน database
- ตรวจสอบ price consistency สำหรับ flight analysis
- แสดงรายงานปัญหาที่พบ (ถ้ามี)

**Notes:**
- ใช้สำหรับ debugging และ validation
- รันก่อน deploy เพื่อตรวจสอบข้อมูล

---

## 🧪 Testing Scripts

Scripts สำหรับทดสอบระบบ

### 7. test-api-endpoints.ts

**Purpose:** ทดสอบ API endpoints ทั้งหมด

**Location:** `backend/src/scripts/test-api-endpoints.ts`

**Usage:**

```bash
cd backend
npm run test:api
```

**Tests:**
- ✅ Health check endpoint
- ✅ Flight search endpoint
- ✅ Flight analysis endpoint
- ✅ Cheapest dates endpoint
- ✅ Destination inspiration endpoint
- ✅ Airport search endpoint

**Output:**
```
🧪 Testing API Endpoints...
==================================================
✅ Health Check: PASS
✅ Flight Search: PASS (25 results)
✅ Flight Analysis: PASS (3 seasons)
✅ Cheapest Dates: PASS (10 dates)
✅ Inspiration: PASS (5 destinations)
✅ Airport Search: PASS (3 airports)
==================================================
✅ All tests passed!
```

---

## 📦 NPM Scripts Reference

รวมคำสั่ง npm ทั้งหมดที่ใช้ในโปรเจค

### Backend Scripts

```json
{
  // Development
  "dev": "tsx watch src/server.ts",
  "build": "tsc",
  "start": "node dist/server.js",
  
  // Database
  "migrate": "tsx src/scripts/run-migrations.ts",
  
  // Data Fetching
  "fetch:daily-weather": "tsx src/scripts/fetch-daily-weather.ts",
  "fetch:holidays": "tsx src/scripts/fetch-holidays-to-csv.ts",
  
  // Data Import
  "import:daily-weather": "tsx src/scripts/import-daily-weather-from-csv.ts",
  "import:holidays": "tsx src/scripts/import-holidays-from-csv.ts",
  
  // Data Generation
  "generate:mock-flights": "tsx src/scripts/generate-mock-flights.ts",
  
  // Maintenance
  "validate:prices": "tsx src/scripts/validatePriceConsistency.ts",
  
  // Testing
  "test:api": "tsx src/scripts/test-api-endpoints.ts",
  "test:price-consistency": "jest src/tests/unit/flightAnalysisService.priceConsistency.test.ts",
  "test:integration:price-consistency": "jest src/tests/integration/flightController.priceConsistency.test.ts",
  
  // Docker
  "docker:up": "docker-compose up -d",
  "docker:down": "docker-compose down",
  "docker:down:volumes": "docker-compose down -v",
  "docker:logs": "docker-compose logs -f postgres",
  "docker:logs:tail": "docker-compose logs --tail=50 postgres",
  "docker:restart": "docker-compose restart",
  "docker:reset": "docker-compose down -v && docker-compose up -d",
  "docker:fix": "docker-compose down -v && docker rm -f flight_search_db && docker-compose up -d",
  "docker:simple": "docker-compose -f docker-compose.simple.yml up -d"
}
```

---

## 🎯 Common Workflows

### Workflow 1: Setup โปรเจคใหม่

```bash
# 1. Clone & Install
git clone <repo-url>
cd Search-Flight_Project
cd backend && npm install
cd ../frontend && npm install

# 2. Start Database (Docker)
cd backend
docker-compose up -d

# 3. Run Migrations
npm run migrate

# 4. Fetch Daily Weather Data
npm run fetch:daily-weather -- --start-date=2020-01-01 --end-date=2025-12-31

# 5. Import Daily Weather Data
npm run import:daily-weather

# 6. Fetch Holiday Data
npm run fetch:holidays -- --start-year=2024 --end-year=2026

# 7. Import Holiday Data
npm run import:holidays

# 6. Generate Mock Flights (1 year)
npm run generate:mock-flights -- --days-back=180 --days-forward=180

# 7. Start Backend
npm run dev
```

---

### Workflow 2: Update ข้อมูลสภาพอากาศ

```bash
cd backend

# Fetch ข้อมูลรายวันล่าสุด
npm run fetch:daily-weather -- --start-date=2024-01-01 --end-date=2025-12-31

# Import เข้า database
npm run import:daily-weather
```

---

### Workflow 3: เคลียร์และสร้างข้อมูล Mock ใหม่

```bash
cd backend

# 1. Connect to database
docker exec -it flight_search_db psql -U postgres -d flight_search

# 2. Clear old data
TRUNCATE TABLE flight_prices;
\q

# 3. Generate new data
npm run generate:mock-flights -- --days-back=90 --days-forward=270

# ✅ Done! มี 132,990 flights ใหม่
```

---

### Workflow 4: ทดสอบระบบหลัง Deploy

```bash
cd backend

# Test all endpoints
npm run test:api

# If pass, good to go! 🚀
```

---

## 🔍 Script Locations Summary

```
backend/src/scripts/
├── fetch-daily-weather.ts           # Fetch daily weather from Open-Meteo & OpenWeatherMap
├── fetch-holidays-to-csv.ts         # Fetch holidays from iApp API
├── import-daily-weather-from-csv.ts # Import daily weather CSV to database
├── import-holidays-from-csv.ts      # Import holidays CSV to database
├── generate-mock-flights.ts         # Generate mock flight data
├── test-api-endpoints.ts            # Test all API endpoints
└── validatePriceConsistency.ts      # Validate price consistency
```

---

## 💡 Tips & Best Practices

### 1. Weather Data
- ✅ Fetch ข้อมูลรายวัน (daily data) ไม่ใช่ monthly averages
- ✅ Fetch ข้อมูลอย่างน้อย 2-3 ปีย้อนหลัง
- ✅ Update ทุก 3-6 เดือน
- ✅ เก็บ CSV ไว้เป็น backup
- ✅ ใช้ `--skip-existing` เมื่อ import ข้อมูลที่มีอยู่แล้วบางส่วน

### 2. Holiday Data
- ✅ Update ทุกปีเมื่อมีประกาศวันหยุดใหม่
- ✅ ตรวจสอบ long weekends
- ✅ เพิ่มวันหยุดพิเศษ (ถ้ามี)

### 3. Mock Flight Data
- ✅ Generate อย่างน้อย 180 days forward
- ✅ Clear ข้อมูลเก่าก่อน re-generate
- ✅ ใช้ batch insert เพื่อความเร็ว

### 4. Database Backup
```bash
# Backup before major changes
docker exec flight_search_db pg_dump -U postgres flight_search > backup_$(date +%Y%m%d).sql

# Restore if needed
cat backup_20241231.sql | docker exec -i flight_search_db psql -U postgres -d flight_search
```

---

## 🆘 Troubleshooting Scripts

### Script ไม่รัน

```bash
# ตรวจสอบ node version
node --version  # Should be v18+

# ตรวจสอบ dependencies
cd backend
npm install

# ตรวจสอบ TypeScript
npx tsx --version
```

### Fetch Weather Error

```bash
# Error: Rate limit exceeded (Open-Meteo)
# Solution: รอ 1 ชั่วโมง (10,000 requests/day)

# Error: OpenWeatherMap API key missing
# Solution: เพิ่ม OPENWEATHERMAP_API_KEY ใน .env (optional, สำหรับ forecast data)

# Error: Invalid province
# Solution: ตรวจสอบชื่อจังหวัดใน script (ต้องใช้ slug format: chiang-mai)
```

### Database Connection Error

```bash
# ตรวจสอบ Docker container
docker ps

# ถ้า container ไม่รัน
docker-compose up -d

# ตรวจสอบ connection
docker exec -it flight_search_db psql -U postgres -d flight_search -c "SELECT 1;"
```

### Mock Data Generation Slow

```bash
# ควรใช้เวลา ~30-40 วินาที สำหรับ 130,000 records
# ถ้าช้ากว่านี้:

# 1. ตรวจสอบ database performance
docker stats flight_search_db

# 2. ลด date range
npm run generate:mock-flights -- --days-back=30 --days-forward=90

# 3. ตรวจสอบ disk space
docker system df
```

---

## 📚 Related Documentation

- [Getting Started Guide](./01-GETTING-STARTED.md) - Setup โปรเจค
- [SQL Commands Reference](./02-SQL-COMMANDS.md) - SQL สำหรับจัดการข้อมูล
- [System Documentation](./03-SYSTEM-DOCUMENTATION.md) - Architecture & APIs
- [Quick Reference](./QUICK-REFERENCE.md) - Cheat sheet

---

**Last Updated:** 2025-12-30  
**Version:** 1.1.0

