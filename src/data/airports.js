// Airport data: IATA code, name, city, country, lat, lon, population (millions, metro area)
// Population drives passenger demand in the gravity model.
// effectivePop (optional): demand catchment in millions for major hubs whose metro population
//   understates true demand due to connecting traffic / national gateway role.
//   When set it is authoritative and overrides the visitors/gateway terms below.
// visitors (optional): annual inbound visitors/tourists in millions. Captures tourism
//   magnets whose demand far exceeds their population (e.g. Malé, Aruba). See market.js
//   getDemandMass() — each 1M visitors adds TOURISM_VISITOR_WEIGHT to demand mass.
// gateway (optional): extra national catchment in millions that routes through this
//   airport as a country's primary international gateway (rule of thumb: national pop −
//   metro pop). Captures capitals like Ulaanbaatar whose pull exceeds city size.
// tier: 'mega' | 'major' | 'regional' — affects hub bonus calculations

export const AIRPORTS = [
  // ── NORTH AMERICA ───────────────────────────────────────────────────────────
  { code: 'JFK', name: 'John F. Kennedy Intl',      city: 'New York',       country: 'US', lat: 40.64,  lon: -73.78,   population: 20.1, tier: 'mega'     },
  { code: 'LAX', name: 'Los Angeles Intl',           city: 'Los Angeles',    country: 'US', lat: 33.94,  lon: -118.40,  population: 13.2, tier: 'mega'     },
  { code: 'ORD', name: "O'Hare Intl",                city: 'Chicago',        country: 'US', lat: 41.97,  lon: -87.90,   population: 9.5,  tier: 'mega'     },
  { code: 'ATL', name: 'Hartsfield-Jackson',         city: 'Atlanta',        country: 'US', lat: 33.64,  lon: -84.43,   population: 6.2,  tier: 'mega'     },
  { code: 'DFW', name: 'Dallas/Fort Worth Intl',     city: 'Dallas',         country: 'US', lat: 32.90,  lon: -97.04,   population: 7.7,  tier: 'mega'     },
  { code: 'DEN', name: 'Denver Intl',                city: 'Denver',         country: 'US', lat: 39.86,  lon: -104.67,  population: 2.9,  tier: 'major'    },
  { code: 'SFO', name: 'San Francisco Intl',         city: 'San Francisco',  country: 'US', lat: 37.62,  lon: -122.38,  population: 4.7,  tier: 'major',  effectivePop: 10 },
  { code: 'SEA', name: 'Seattle-Tacoma Intl',        city: 'Seattle',        country: 'US', lat: 47.45,  lon: -122.31,  population: 4.0,  tier: 'major'    },
  { code: 'PAE', name: 'Paine Field (Snohomish County)', city: 'Everett',     country: 'US', lat: 47.91,  lon: -122.28,  population: 1.5,  tier: 'regional' },
  { code: 'BLI', name: 'Bellingham Intl',            city: 'Bellingham',     country: 'US', lat: 48.79,  lon: -122.54,  population: 0.4,  tier: 'regional' },
  // ── Alaska "Milk Run" completeness (KTN-WRG-PSG-JNU-SIT-YAK-CDV-ANC) ──────────
  { code: 'KTN', name: 'Ketchikan Intl',             city: 'Ketchikan',      country: 'US', lat: 55.36,  lon: -131.71,  population: 0.014, tier: 'regional', visitors: 0.6 },
  { code: 'PSG', name: 'Petersburg James A. Johnson', city: 'Petersburg',    country: 'US', lat: 56.80,  lon: -132.95,  population: 0.003, tier: 'regional' },
  { code: 'YAK', name: 'Yakutat',                    city: 'Yakutat',        country: 'US', lat: 59.51,  lon: -139.66,  population: 0.001, tier: 'regional' },
  // ── Pacific "Island Hopper" completeness (HNL-MAJ-KWA-KSA-PNI-TKK-GUM) ────────
  { code: 'KWA', name: 'Bucholz AAF',                city: 'Kwajalein',      country: 'MH', lat: 8.72,   lon: 167.73,   population: 0.011, tier: 'regional' },
  { code: 'KSA', name: 'Kosrae Intl',               city: 'Kosrae',         country: 'FM', lat: 5.36,   lon: 162.96,   population: 0.006, tier: 'regional' },
  { code: 'TKK', name: 'Chuuk Intl',                city: 'Weno',           country: 'FM', lat: 7.46,   lon: 151.84,   population: 0.05,  tier: 'regional' },
  { code: 'MIA', name: 'Miami Intl',                 city: 'Miami',          country: 'US', lat: 25.79,  lon: -80.29,   population: 6.2,  tier: 'major'    },
  { code: 'BOS', name: 'Logan Intl',                 city: 'Boston',         country: 'US', lat: 42.37,  lon: -71.00,   population: 4.9,  tier: 'major'    },
  { code: 'LAS', name: 'Harry Reid Intl',            city: 'Las Vegas',      country: 'US', lat: 36.08,  lon: -115.15,  population: 2.3,  tier: 'major'    },
  { code: 'PHX', name: 'Phoenix Sky Harbor',         city: 'Phoenix',        country: 'US', lat: 33.44,  lon: -112.01,  population: 5.1,  tier: 'major'    },
  { code: 'IAD', name: 'Dulles Intl',                city: 'Washington DC',  country: 'US', lat: 38.94,  lon: -77.46,   population: 6.4,  tier: 'major'    },
  { code: 'MSP', name: 'Minneapolis-St. Paul Intl',  city: 'Minneapolis',    country: 'US', lat: 44.88,  lon: -93.22,   population: 3.7,  tier: 'major'    },
  { code: 'YYZ', name: 'Toronto Pearson Intl',       city: 'Toronto',        country: 'CA', lat: 43.68,  lon: -79.63,   population: 6.2,  tier: 'mega'     },
  { code: 'YVR', name: 'Vancouver Intl',             city: 'Vancouver',      country: 'CA', lat: 49.19,  lon: -123.18,  population: 2.6,  tier: 'major'    },
  { code: 'YUL', name: 'Montréal-Trudeau Intl',      city: 'Montreal',       country: 'CA', lat: 45.47,  lon: -73.74,   population: 4.2,  tier: 'major'    },
  { code: 'MEX', name: 'Benito Juárez Intl',         city: 'Mexico City',    country: 'MX', lat: 19.44,  lon: -99.07,   population: 21.7, tier: 'mega'     },
  { code: 'GDL', name: 'Miguel Hidalgo Intl',        city: 'Guadalajara',    country: 'MX', lat: 20.52,  lon: -103.31,  population: 5.3,  tier: 'regional' },
  { code: 'CUN', name: 'Cancún Intl',                city: 'Cancún',         country: 'MX', lat: 21.04,  lon: -86.87,   population: 0.9,  tier: 'regional' },
  { code: 'PTY', name: 'Tocumen Intl',               city: 'Panama City',    country: 'PA', lat: 9.07,   lon: -79.38,   population: 2.0,  tier: 'regional' },

  // ── SOUTH AMERICA ────────────────────────────────────────────────────────────
  { code: 'GRU', name: 'São Paulo/Guarulhos Intl',   city: 'São Paulo',      country: 'BR', lat: -23.43, lon: -46.47,   population: 22.4, tier: 'mega'     },
  { code: 'GIG', name: 'Rio Galeão Intl',            city: 'Rio de Janeiro', country: 'BR', lat: -22.81, lon: -43.25,   population: 13.6, tier: 'major'    },
  { code: 'BSB', name: 'Pres. Juscelino K. Intl',    city: 'Brasília',       country: 'BR', lat: -15.87, lon: -47.92,   population: 3.0,  tier: 'regional' },
  { code: 'EZE', name: 'Ministro Pistarini Intl',    city: 'Buenos Aires',   country: 'AR', lat: -34.82, lon: -58.53,   population: 15.0, tier: 'mega'     },
  { code: 'SCL', name: 'Arturo Merino Benítez Intl', city: 'Santiago',       country: 'CL', lat: -33.39, lon: -70.79,   population: 7.4,  tier: 'major'    },
  { code: 'BOG', name: 'El Dorado Intl',             city: 'Bogotá',         country: 'CO', lat: 4.70,   lon: -74.15,   population: 11.3, tier: 'major'    },
  { code: 'LIM', name: 'Jorge Chávez Intl',          city: 'Lima',           country: 'PE', lat: -12.02, lon: -77.11,   population: 11.0, tier: 'major'    },

  // ── EUROPE ───────────────────────────────────────────────────────────────────
  { code: 'LHR', name: 'Heathrow',                   city: 'London',         country: 'GB', lat: 51.47,  lon: -0.45,    population: 9.3,  tier: 'mega', effectivePop: 22 },
  { code: 'CDG', name: 'Charles de Gaulle',          city: 'Paris',          country: 'FR', lat: 49.01,  lon: 2.55,     population: 11.0, tier: 'mega'     },
  { code: 'FRA', name: 'Frankfurt Airport',          city: 'Frankfurt',      country: 'DE', lat: 50.03,  lon: 8.57,     population: 5.8,  tier: 'mega',  effectivePop: 12 },
  { code: 'AMS', name: 'Amsterdam Schiphol',         city: 'Amsterdam',      country: 'NL', lat: 52.31,  lon: 4.77,     population: 2.5,  tier: 'mega',  effectivePop: 9  },
  { code: 'MAD', name: 'Adolfo Suárez Barajas',      city: 'Madrid',         country: 'ES', lat: 40.47,  lon: -3.57,    population: 6.7,  tier: 'major'    },
  { code: 'BCN', name: 'Josep Tarradellas Barcelona',city: 'Barcelona',      country: 'ES', lat: 41.30,  lon: 2.08,     population: 5.6,  tier: 'major'    },
  { code: 'FCO', name: 'Fiumicino',                  city: 'Rome',           country: 'IT', lat: 41.80,  lon: 12.24,    population: 4.3,  tier: 'major'    },
  { code: 'MXP', name: 'Malpensa',                   city: 'Milan',          country: 'IT', lat: 45.63,  lon: 8.73,     population: 3.2,  tier: 'major'    },
  { code: 'MUC', name: 'Munich Airport',             city: 'Munich',         country: 'DE', lat: 48.35,  lon: 11.79,    population: 2.9,  tier: 'major'    },
  { code: 'ZRH', name: 'Zurich Airport',             city: 'Zurich',         country: 'CH', lat: 47.46,  lon: 8.55,     population: 1.4,  tier: 'major'    },
  { code: 'VIE', name: 'Vienna Intl',                city: 'Vienna',         country: 'AT', lat: 48.11,  lon: 16.57,    population: 1.9,  tier: 'major'    },
  { code: 'BRU', name: 'Brussels Airport',           city: 'Brussels',       country: 'BE', lat: 50.90,  lon: 4.48,     population: 2.1,  tier: 'major'    },
  { code: 'LIS', name: 'Humberto Delgado Airport',   city: 'Lisbon',         country: 'PT', lat: 38.77,  lon: -9.13,    population: 2.9,  tier: 'major'    },
  { code: 'OSL', name: 'Oslo Gardermoen',            city: 'Oslo',           country: 'NO', lat: 60.20,  lon: 11.08,    population: 1.0,  tier: 'regional' },
  { code: 'ARN', name: 'Stockholm Arlanda',          city: 'Stockholm',      country: 'SE', lat: 59.65,  lon: 17.92,    population: 2.4,  tier: 'regional' },
  { code: 'HEL', name: 'Helsinki-Vantaa',            city: 'Helsinki',       country: 'FI', lat: 60.32,  lon: 24.96,    population: 1.5,  tier: 'regional' },
  { code: 'CPH', name: 'Copenhagen Airport',         city: 'Copenhagen',     country: 'DK', lat: 55.62,  lon: 12.66,    population: 1.3,  tier: 'major'    },
  { code: 'DUB', name: 'Dublin Airport',             city: 'Dublin',         country: 'IE', lat: 53.42,  lon: -6.27,    population: 1.4,  tier: 'regional' },
  { code: 'WAW', name: 'Chopin Airport',             city: 'Warsaw',         country: 'PL', lat: 52.17,  lon: 20.97,    population: 1.8,  tier: 'regional' },
  { code: 'ATH', name: 'Athens Intl',                city: 'Athens',         country: 'GR', lat: 37.94,  lon: 23.95,    population: 3.7,  tier: 'major'    },
  { code: 'IST', name: 'Istanbul Airport',           city: 'Istanbul',       country: 'TR', lat: 41.26,  lon: 28.74,    population: 15.6, tier: 'mega'     },

  // ── MIDDLE EAST ──────────────────────────────────────────────────────────────
  { code: 'DXB', name: 'Dubai Intl',                 city: 'Dubai',          country: 'AE', lat: 25.25,  lon: 55.36,    population: 3.3,  tier: 'mega', effectivePop: 18 },
  { code: 'AUH', name: 'Abu Dhabi Intl',             city: 'Abu Dhabi',      country: 'AE', lat: 24.44,  lon: 54.65,    population: 1.5,  tier: 'major'    },
  { code: 'DOH', name: 'Hamad Intl',                 city: 'Doha',           country: 'QA', lat: 25.27,  lon: 51.61,    population: 2.4,  tier: 'mega',  effectivePop: 8 },
  { code: 'RUH', name: 'King Khalid Intl',           city: 'Riyadh',         country: 'SA', lat: 24.96,  lon: 46.70,    population: 7.7,  tier: 'major'    },
  { code: 'TLV', name: 'Ben Gurion Intl',            city: 'Tel Aviv',       country: 'IL', lat: 32.01,  lon: 34.89,    population: 4.3,  tier: 'major'    },

  // ── AFRICA ───────────────────────────────────────────────────────────────────
  { code: 'JNB', name: 'O.R. Tambo Intl',           city: 'Johannesburg',   country: 'ZA', lat: -26.13, lon: 28.24,    population: 10.0, tier: 'major'    },
  { code: 'CPT', name: 'Cape Town Intl',             city: 'Cape Town',      country: 'ZA', lat: -33.96, lon: 18.60,    population: 4.6,  tier: 'regional' },
  { code: 'CAI', name: 'Cairo Intl',                 city: 'Cairo',          country: 'EG', lat: 30.11,  lon: 31.40,    population: 21.3, tier: 'mega'     },
  { code: 'NBO', name: 'Jomo Kenyatta Intl',         city: 'Nairobi',        country: 'KE', lat: -1.32,  lon: 36.93,    population: 5.1,  tier: 'regional' },
  { code: 'LOS', name: 'Murtala Muhammed Intl',      city: 'Lagos',          country: 'NG', lat: 6.58,   lon: 3.32,     population: 14.9, tier: 'major'    },
  { code: 'CMN', name: 'Mohammed V Intl',            city: 'Casablanca',     country: 'MA', lat: 33.37,  lon: -7.59,    population: 4.4,  tier: 'regional' },
  { code: 'ADD', name: 'Addis Ababa Bole Intl',      city: 'Addis Ababa',    country: 'ET', lat: 8.98,   lon: 38.80,    population: 5.0,  tier: 'regional' },

  // ── SOUTH & SOUTHEAST ASIA ──────────────────────────────────────────────────
  { code: 'SIN', name: 'Changi Airport',             city: 'Singapore',      country: 'SG', lat: 1.36,   lon: 103.99,   population: 5.7,  tier: 'mega', effectivePop: 22 },
  { code: 'HKG', name: 'Hong Kong Intl',             city: 'Hong Kong',      country: 'HK', lat: 22.31,  lon: 113.91,   population: 7.5,  tier: 'mega', effectivePop: 18 },
  { code: 'KUL', name: 'Kuala Lumpur Intl',          city: 'Kuala Lumpur',   country: 'MY', lat: 2.74,   lon: 101.71,   population: 8.3,  tier: 'major'    },
  { code: 'BKK', name: 'Suvarnabhumi Airport',       city: 'Bangkok',        country: 'TH', lat: 13.69,  lon: 100.75,   population: 15.7, tier: 'major'    },
  { code: 'CGK', name: 'Soekarno-Hatta Intl',        city: 'Jakarta',        country: 'ID', lat: -6.13,  lon: 106.66,   population: 34.5, tier: 'mega'     },
  { code: 'MNL', name: 'Ninoy Aquino Intl',          city: 'Manila',         country: 'PH', lat: 14.51,  lon: 121.02,   population: 14.4, tier: 'major'    },
  { code: 'DEL', name: 'Indira Gandhi Intl',         city: 'Delhi',          country: 'IN', lat: 28.56,  lon: 77.10,    population: 32.9, tier: 'mega'     },
  { code: 'BOM', name: 'Chhatrapati Shivaji Intl',   city: 'Mumbai',         country: 'IN', lat: 19.09,  lon: 72.87,    population: 20.7, tier: 'mega'     },
  { code: 'BLR', name: 'Kempegowda Intl',            city: 'Bangalore',      country: 'IN', lat: 13.20,  lon: 77.71,    population: 13.2, tier: 'major'    },
  { code: 'CMB', name: 'Bandaranaike Intl',          city: 'Colombo',        country: 'LK', lat: 7.18,   lon: 79.88,    population: 3.7,  tier: 'regional' },

  // ── EAST ASIA ────────────────────────────────────────────────────────────────
  { code: 'NRT', name: 'Narita Intl',                city: 'Tokyo',          country: 'JP', lat: 35.76,  lon: 140.38,   population: 37.4, tier: 'mega'     },
  { code: 'HND', name: 'Tokyo Haneda',               city: 'Tokyo',          country: 'JP', lat: 35.55,  lon: 139.78,   population: 37.4, tier: 'mega'     },
  { code: 'KIX', name: 'Kansai Intl',                city: 'Osaka',          country: 'JP', lat: 34.43,  lon: 135.24,   population: 19.3, tier: 'major'    },
  { code: 'ICN', name: 'Incheon Intl',               city: 'Seoul',          country: 'KR', lat: 37.46,  lon: 126.44,   population: 9.8,  tier: 'mega'     },
  { code: 'PEK', name: 'Beijing Capital Intl',       city: 'Beijing',        country: 'CN', lat: 40.08,  lon: 116.58,   population: 21.5, tier: 'mega'     },
  { code: 'PVG', name: 'Shanghai Pudong Intl',       city: 'Shanghai',       country: 'CN', lat: 31.14,  lon: 121.80,   population: 27.1, tier: 'mega'     },
  { code: 'CAN', name: 'Guangzhou Baiyun Intl',      city: 'Guangzhou',      country: 'CN', lat: 23.39,  lon: 113.30,   population: 18.7, tier: 'mega'     },
  { code: 'CTU', name: 'Chengdu Tianfu Intl',        city: 'Chengdu',        country: 'CN', lat: 30.31,  lon: 104.44,   population: 9.1,  tier: 'major'    },
  { code: 'TPE', name: 'Taoyuan Intl',               city: 'Taipei',         country: 'TW', lat: 25.08,  lon: 121.23,   population: 7.0,  tier: 'major'    },

  // ── OCEANIA ──────────────────────────────────────────────────────────────────
  { code: 'SYD', name: 'Kingsford Smith',            city: 'Sydney',         country: 'AU', lat: -33.94, lon: 151.18,   population: 5.3,  tier: 'major'    },
  { code: 'WSI', name: 'Western Sydney (Nancy-Bird Walton)', city: 'Sydney', country: 'AU', lat: -33.89, lon: 150.71, population: 2.8, tier: 'regional' },
  { code: 'MEL', name: 'Melbourne Airport',          city: 'Melbourne',      country: 'AU', lat: -37.67, lon: 144.84,   population: 5.1,  tier: 'major'    },
  { code: 'BNE', name: 'Brisbane Airport',           city: 'Brisbane',       country: 'AU', lat: -27.38, lon: 153.12,   population: 2.5,  tier: 'regional' },
  { code: 'AKL', name: 'Auckland Airport',           city: 'Auckland',       country: 'NZ', lat: -37.01, lon: 174.79,   population: 1.7,  tier: 'regional' },

  // ── NORTH AMERICA (additional) ───────────────────────────────────────────────
  { code: 'EWR', name: 'Newark Liberty Intl',          city: 'New York',        country: 'US', lat: 40.69,  lon: -74.17,   population: 20.1, tier: 'major'    },
  { code: 'LGA', name: 'LaGuardia Airport',             city: 'New York',        country: 'US', lat: 40.78,  lon: -73.87,   population: 20.1, tier: 'major'    },
  { code: 'ISP', name: 'Long Island MacArthur Airport', city: 'Islip',           country: 'US', lat: 40.79,  lon: -73.10,   population: 1.5,  tier: 'regional' },
  { code: 'SAN', name: 'San Diego Intl',                city: 'San Diego',       country: 'US', lat: 32.73,  lon: -117.19,  population: 3.3,  tier: 'regional' },
  { code: 'MCO', name: 'Orlando Intl',                  city: 'Orlando',         country: 'US', lat: 28.43,  lon: -81.31,   population: 2.7,  tier: 'major'    },
  { code: 'TPA', name: 'Tampa Intl',                    city: 'Tampa',           country: 'US', lat: 27.98,  lon: -82.53,   population: 3.2,  tier: 'regional' },
  { code: 'DTW', name: 'Detroit Metro Wayne County',    city: 'Detroit',         country: 'US', lat: 42.21,  lon: -83.35,   population: 4.4,  tier: 'major'    },
  { code: 'PHL', name: 'Philadelphia Intl',             city: 'Philadelphia',    country: 'US', lat: 39.87,  lon: -75.24,   population: 6.1,  tier: 'major'    },
  { code: 'CLT', name: 'Charlotte Douglas Intl',        city: 'Charlotte',       country: 'US', lat: 35.21,  lon: -80.94,   population: 2.7,  tier: 'major'    },
  { code: 'BWI', name: 'Baltimore/Washington Intl',     city: 'Baltimore',       country: 'US', lat: 39.17,  lon: -76.67,   population: 2.9,  tier: 'regional' },
  { code: 'DCA', name: 'Reagan National Airport',        city: 'Washington DC',   country: 'US', lat: 38.85,  lon: -77.04,   population: 6.4,  tier: 'major'    },
  { code: 'IAH', name: 'George Bush Intercontinental',  city: 'Houston',         country: 'US', lat: 29.98,  lon: -95.34,   population: 7.3,  tier: 'major'    },
  { code: 'HOU', name: 'William P. Hobby Airport',      city: 'Houston',         country: 'US', lat: 29.65,  lon: -95.28,   population: 7.3,  tier: 'regional' },
  { code: 'SLC', name: 'Salt Lake City Intl',           city: 'Salt Lake City',  country: 'US', lat: 40.79,  lon: -111.98,  population: 1.2,  tier: 'regional' },
  { code: 'PDX', name: 'Portland Intl',                 city: 'Portland',        country: 'US', lat: 45.59,  lon: -122.60,  population: 2.5,  tier: 'regional' },
  { code: 'OAK', name: 'Oakland Intl',                  city: 'Oakland',         country: 'US', lat: 37.72,  lon: -122.22,  population: 4.7,  tier: 'regional' },
  { code: 'SJC', name: 'Norman Y. Mineta San Jose',     city: 'San Jose',        country: 'US', lat: 37.36,  lon: -121.93,  population: 2.0,  tier: 'regional' },
  { code: 'SMF', name: 'Sacramento Intl',               city: 'Sacramento',      country: 'US', lat: 38.70,  lon: -121.59,  population: 2.3,  tier: 'regional' },
  { code: 'RNO', name: 'Reno-Tahoe Intl',               city: 'Reno',            country: 'US', lat: 39.50,  lon: -119.77,  population: 0.5,  tier: 'regional' },
  { code: 'DRO', name: 'Durango-La Plata County Airport', city: 'Durango',       country: 'US', lat: 37.15,  lon: -107.75,  population: 0.06, tier: 'regional', visitors: 0.5 },
  { code: 'STL', name: 'Lambert-St. Louis Intl',        city: 'St. Louis',       country: 'US', lat: 38.75,  lon: -90.37,   population: 2.8,  tier: 'regional' },
  { code: 'BNA', name: 'Nashville Intl',                city: 'Nashville',       country: 'US', lat: 36.12,  lon: -86.68,   population: 2.0,  tier: 'regional' },
  { code: 'MSY', name: 'Louis Armstrong Intl',          city: 'New Orleans',     country: 'US', lat: 29.99,  lon: -90.26,   population: 1.3,  tier: 'regional' },
  { code: 'MEM', name: 'Memphis Intl',                  city: 'Memphis',         country: 'US', lat: 35.04,  lon: -89.98,   population: 1.3,  tier: 'regional' },
  { code: 'IND', name: 'Indianapolis Intl',             city: 'Indianapolis',    country: 'US', lat: 39.72,  lon: -86.29,   population: 2.1,  tier: 'regional' },
  { code: 'CLE', name: 'Cleveland Hopkins Intl',        city: 'Cleveland',       country: 'US', lat: 41.41,  lon: -81.85,   population: 2.0,  tier: 'regional' },
  { code: 'CMH', name: 'John Glenn Columbus Intl',      city: 'Columbus',        country: 'US', lat: 40.00,  lon: -82.89,   population: 2.1,  tier: 'regional' },
  { code: 'PIT', name: 'Pittsburgh Intl',               city: 'Pittsburgh',      country: 'US', lat: 40.49,  lon: -80.23,   population: 2.4,  tier: 'regional' },
  { code: 'RDU', name: 'Raleigh-Durham Intl',           city: 'Raleigh',         country: 'US', lat: 35.88,  lon: -78.79,   population: 1.4,  tier: 'regional' },
  { code: 'JAX', name: 'Jacksonville Intl',             city: 'Jacksonville',    country: 'US', lat: 30.49,  lon: -81.69,   population: 1.5,  tier: 'regional' },
  { code: 'AUS', name: 'Austin-Bergstrom Intl',         city: 'Austin',          country: 'US', lat: 30.20,  lon: -97.67,   population: 2.2,  tier: 'regional' },
  { code: 'SAT', name: 'San Antonio Intl',              city: 'San Antonio',     country: 'US', lat: 29.53,  lon: -98.47,   population: 2.5,  tier: 'regional' },
  { code: 'FLL', name: 'Fort Lauderdale-Hollywood Intl',city: 'Fort Lauderdale', country: 'US', lat: 26.07,  lon: -80.15,   population: 1.9,  tier: 'regional' },
  { code: 'PBI', name: 'Palm Beach Intl',               city: 'West Palm Beach', country: 'US', lat: 26.68,  lon: -80.10,   population: 1.5,  tier: 'regional' },
  { code: 'RSW', name: 'Southwest Florida Intl',        city: 'Fort Myers',      country: 'US', lat: 26.54,  lon: -81.76,   population: 0.8,  tier: 'regional', visitors: 3.0 },
  { code: 'ABQ', name: 'Albuquerque Sunport',           city: 'Albuquerque',     country: 'US', lat: 35.04,  lon: -106.61,  population: 0.9,  tier: 'regional' },
  { code: 'BOI', name: 'Boise Airport',                 city: 'Boise',           country: 'US', lat: 43.56,  lon: -116.22,  population: 0.8,  tier: 'regional' },
  { code: 'GEG', name: 'Spokane Intl',                  city: 'Spokane',         country: 'US', lat: 47.62,  lon: -117.53,  population: 0.6,  tier: 'regional' },
  { code: 'TUS', name: 'Tucson Intl',                   city: 'Tucson',          country: 'US', lat: 32.12,  lon: -110.94,  population: 1.0,  tier: 'regional' },
  { code: 'ELP', name: 'El Paso Intl',                  city: 'El Paso',         country: 'US', lat: 31.81,  lon: -106.38,  population: 0.8,  tier: 'regional' },
  { code: 'OMA', name: 'Eppley Airfield',               city: 'Omaha',           country: 'US', lat: 41.30,  lon: -95.89,   population: 0.9,  tier: 'regional' },
  { code: 'DSM', name: 'Des Moines Intl',               city: 'Des Moines',      country: 'US', lat: 41.53,  lon: -93.66,   population: 0.7,  tier: 'regional' },
  { code: 'MKE', name: 'Milwaukee Mitchell Intl',       city: 'Milwaukee',       country: 'US', lat: 42.95,  lon: -87.90,   population: 1.6,  tier: 'regional' },
  { code: 'MDW', name: 'Chicago Midway Intl',           city: 'Chicago',         country: 'US', lat: 41.79,  lon: -87.75,   population: 9.5,  tier: 'regional' },
  { code: 'BHM', name: 'Birmingham-Shuttlesworth Intl', city: 'Birmingham',      country: 'US', lat: 33.56,  lon: -86.75,   population: 1.1,  tier: 'regional' },
  { code: 'SDF', name: 'Louisville Intl',               city: 'Louisville',      country: 'US', lat: 38.17,  lon: -85.74,   population: 1.4,  tier: 'regional' },
  { code: 'RIC', name: 'Richmond Intl',                 city: 'Richmond',        country: 'US', lat: 37.50,  lon: -77.32,   population: 1.3,  tier: 'regional' },
  { code: 'ORF', name: 'Norfolk Intl',                  city: 'Norfolk',         country: 'US', lat: 36.90,  lon: -76.02,   population: 1.8,  tier: 'regional' },
  { code: 'OKC', name: 'Will Rogers World Airport',     city: 'Oklahoma City',   country: 'US', lat: 35.39,  lon: -97.60,   population: 1.4,  tier: 'regional' },
  { code: 'TUL', name: 'Tulsa Intl',                    city: 'Tulsa',           country: 'US', lat: 36.20,  lon: -95.89,   population: 1.0,  tier: 'regional' },
  { code: 'GSP', name: 'Greenville-Spartanburg Intl',   city: 'Greenville',      country: 'US', lat: 34.90,  lon: -82.22,   population: 0.9,  tier: 'regional' },
  { code: 'HNL', name: 'Daniel K. Inouye Intl',         city: 'Honolulu',        country: 'US', lat: 21.33,  lon: -157.92,  population: 1.0,  tier: 'major'    },
  { code: 'OGG', name: 'Kahului Airport',               city: 'Maui',            country: 'US', lat: 20.90,  lon: -156.43,  population: 0.16, tier: 'regional' },
  { code: 'KOA', name: 'Kona Intl',                     city: 'Kona',            country: 'US', lat: 19.74,  lon: -156.05,  population: 0.09, tier: 'regional' },
  { code: 'ANC', name: 'Ted Stevens Anchorage Intl',    city: 'Anchorage',       country: 'US', lat: 61.17,  lon: -149.99,  population: 0.4,  tier: 'regional' },
  { code: 'SJU', name: 'Luis Munoz Marin Intl',         city: 'San Juan',        country: 'PR', lat: 18.44,  lon: -66.00,   population: 2.4,  tier: 'regional' },
  { code: 'YYC', name: 'Calgary Intl',                  city: 'Calgary',         country: 'CA', lat: 51.13,  lon: -114.01,  population: 1.6,  tier: 'regional' },
  { code: 'YEG', name: 'Edmonton Intl',                 city: 'Edmonton',        country: 'CA', lat: 53.31,  lon: -113.58,  population: 1.4,  tier: 'regional' },
  { code: 'YWG', name: 'Winnipeg Richardson Intl',      city: 'Winnipeg',        country: 'CA', lat: 49.91,  lon: -97.24,   population: 0.8,  tier: 'regional' },
  { code: 'YHZ', name: 'Halifax Stanfield Intl',        city: 'Halifax',         country: 'CA', lat: 44.88,  lon: -63.51,   population: 0.4,  tier: 'regional' },
  { code: 'YOW', name: 'Ottawa Macdonald-Cartier Intl', city: 'Ottawa',          country: 'CA', lat: 45.32,  lon: -75.67,   population: 1.4,  tier: 'regional' },
  { code: 'YQB', name: 'Quebec City Jean Lesage Intl',  city: 'Quebec City',     country: 'CA', lat: 46.79,  lon: -71.39,   population: 0.8,  tier: 'regional' },
  { code: 'MTY', name: 'Monterrey Mariano Escobedo Intl', city: 'Monterrey',     country: 'MX', lat: 25.78,  lon: -100.11,  population: 5.3,  tier: 'regional' },
  { code: 'TIJ', name: 'Tijuana Intl',                  city: 'Tijuana',         country: 'MX', lat: 32.54,  lon: -116.97,  population: 2.0,  tier: 'regional' },
  { code: 'PVR', name: 'Puerto Vallarta Intl',          city: 'Puerto Vallarta', country: 'MX', lat: 20.68,  lon: -105.25,  population: 0.4,  tier: 'regional' },
  { code: 'SJD', name: 'Los Cabos Intl',                city: 'Los Cabos',       country: 'MX', lat: 23.15,  lon: -109.72,  population: 0.3,  tier: 'regional' },
  { code: 'MID', name: 'Merida Intl',                   city: 'Merida',          country: 'MX', lat: 20.94,  lon: -89.66,   population: 1.1,  tier: 'regional' },
  { code: 'BJX', name: 'Del Bajio Intl',                city: 'Leon',            country: 'MX', lat: 20.99,  lon: -101.48,  population: 1.6,  tier: 'regional' },
  { code: 'HAV', name: 'Jose Marti Intl',               city: 'Havana',          country: 'CU', lat: 22.99,  lon: -82.41,   population: 2.1,  tier: 'regional' },
  { code: 'SDQ', name: 'Las Americas Intl',             city: 'Santo Domingo',   country: 'DO', lat: 18.43,  lon: -69.67,   population: 3.3,  tier: 'regional' },
  { code: 'MBJ', name: 'Sangster Intl',                 city: 'Montego Bay',     country: 'JM', lat: 18.50,  lon: -77.91,   population: 0.12, tier: 'regional' },
  { code: 'KIN', name: 'Norman Manley Intl',            city: 'Kingston',        country: 'JM', lat: 17.94,  lon: -76.79,   population: 0.6,  tier: 'regional' },
  { code: 'NAS', name: 'Lynden Pindling Intl',          city: 'Nassau',          country: 'BS', lat: 25.04,  lon: -77.47,   population: 0.27, tier: 'regional' },
  { code: 'BGI', name: 'Grantley Adams Intl',           city: 'Bridgetown',      country: 'BB', lat: 13.07,  lon: -59.49,   population: 0.09, tier: 'regional' },
  { code: 'SXM', name: 'Princess Juliana Intl',         city: 'Sint Maarten',    country: 'SX', lat: 18.04,  lon: -63.11,   population: 0.04, tier: 'regional' },
  { code: 'POS', name: 'Piarco Intl',                   city: 'Port of Spain',   country: 'TT', lat: 10.60,  lon: -61.34,   population: 0.54, tier: 'regional' },
  { code: 'GCM', name: 'Owen Roberts Intl',             city: 'Grand Cayman',    country: 'KY', lat: 19.29,  lon: -81.36,   population: 0.07, tier: 'regional' },
  { code: 'BDA', name: 'L.F. Wade Intl',                city: 'Hamilton',        country: 'BM', lat: 32.36,  lon: -64.68,   population: 0.06, tier: 'regional' },
  { code: 'SAL', name: 'Monsenor Oscar Arnulfo Romero Intl', city: 'San Salvador', country: 'SV', lat: 13.44, lon: -89.05,  population: 2.4,  tier: 'regional' },
  { code: 'GUA', name: 'La Aurora Intl',                city: 'Guatemala City',  country: 'GT', lat: 14.58,  lon: -90.53,   population: 3.0,  tier: 'regional' },
  { code: 'SAP', name: 'Ramon Villeda Morales Intl',    city: 'San Pedro Sula',  country: 'HN', lat: 15.45,  lon: -87.92,   population: 1.3,  tier: 'regional' },
  { code: 'MGA', name: 'Augusto C. Sandino Intl',       city: 'Managua',         country: 'NI', lat: 12.14,  lon: -86.17,   population: 1.4,  tier: 'regional' },
  { code: 'SJO', name: 'Juan Santamaria Intl',          city: 'San Jose',        country: 'CR', lat: 9.99,   lon: -84.21,   population: 1.4,  tier: 'regional' },

  // ── SOUTH AMERICA (additional) ───────────────────────────────────────────────
  { code: 'FOR', name: 'Pinto Martins Intl',            city: 'Fortaleza',       country: 'BR', lat: -3.78,  lon: -38.53,   population: 4.1,  tier: 'regional' },
  { code: 'SSA', name: 'Deputado Luis Eduardo Magalhaes Intl', city: 'Salvador', country: 'BR', lat: -12.91, lon: -38.33,   population: 4.0,  tier: 'regional' },
  { code: 'REC', name: 'Recife Guararapes Intl',        city: 'Recife',          country: 'BR', lat: -8.13,  lon: -34.92,   population: 4.1,  tier: 'regional' },
  { code: 'POA', name: 'Salgado Filho Intl',            city: 'Porto Alegre',    country: 'BR', lat: -29.99, lon: -51.17,   population: 4.3,  tier: 'regional' },
  { code: 'CWB', name: 'Afonso Pena Intl',              city: 'Curitiba',        country: 'BR', lat: -25.53, lon: -49.18,   population: 3.7,  tier: 'regional' },
  { code: 'MAO', name: 'Eduardo Gomes Intl',            city: 'Manaus',          country: 'BR', lat: -3.04,  lon: -60.05,   population: 2.2,  tier: 'regional' },
  { code: 'MDE', name: 'Jose Maria Cordova Intl',       city: 'Medellin',        country: 'CO', lat: 6.17,   lon: -75.43,   population: 4.0,  tier: 'regional' },
  { code: 'CLO', name: 'Alfonso Bonilla Aragon Intl',   city: 'Cali',            country: 'CO', lat: 3.54,   lon: -76.38,   population: 2.8,  tier: 'regional' },
  { code: 'CTG', name: 'Rafael Nunez Intl',             city: 'Cartagena',       country: 'CO', lat: 10.44,  lon: -75.51,   population: 1.0,  tier: 'regional' },
  { code: 'UIO', name: 'Mariscal Sucre Intl',           city: 'Quito',           country: 'EC', lat: -0.13,  lon: -78.36,   population: 2.8,  tier: 'regional' },
  { code: 'GYE', name: 'Jose Joaquin de Olmedo Intl',   city: 'Guayaquil',       country: 'EC', lat: -2.16,  lon: -79.88,   population: 2.7,  tier: 'regional' },
  { code: 'ASU', name: 'Silvio Pettirossi Intl',        city: 'Asuncion',        country: 'PY', lat: -25.24, lon: -57.52,   population: 2.3,  tier: 'regional' },
  { code: 'MVD', name: 'Carrasco Intl',                 city: 'Montevideo',      country: 'UY', lat: -34.84, lon: -56.03,   population: 1.8,  tier: 'regional' },
  { code: 'CCS', name: 'Simon Bolivar Intl',            city: 'Caracas',         country: 'VE', lat: 10.60,  lon: -66.99,   population: 5.2,  tier: 'regional' },
  { code: 'LPB', name: 'El Alto Intl',                  city: 'La Paz',          country: 'BO', lat: -16.51, lon: -68.19,   population: 1.8,  tier: 'regional' },
  { code: 'VVI', name: 'Viru Viru Intl',                city: 'Santa Cruz',      country: 'BO', lat: -17.65, lon: -63.13,   population: 1.7,  tier: 'regional' },
  { code: 'CUR', name: 'Hato Intl',                     city: 'Willemstad',      country: 'CW', lat: 12.19,  lon: -68.96,   population: 0.15, tier: 'regional' },
  { code: 'PBM', name: 'Johan Adolf Pengel Intl',       city: 'Paramaribo',      country: 'SR', lat: 5.45,   lon: -55.19,   population: 0.6,  tier: 'regional' },
  { code: 'BEL', name: 'Val de Cans Intl',              city: 'Belem',           country: 'BR', lat: -1.38,  lon: -48.48,   population: 2.5,  tier: 'regional' },
  { code: 'CGH', name: 'Congonhas Airport',             city: 'Sao Paulo',       country: 'BR', lat: -23.63, lon: -46.66,   population: 22.4, tier: 'major'    },

  // ── EUROPE (additional) ──────────────────────────────────────────────────────
  { code: 'LGW', name: 'Gatwick Airport',               city: 'London',          country: 'GB', lat: 51.15,  lon: -0.18,    population: 9.3,  tier: 'major'    },
  { code: 'LCY', name: 'London City Airport',           city: 'London',          country: 'GB', lat: 51.51,  lon: 0.05,     population: 9.3,  tier: 'regional' },
  { code: 'STN', name: 'Stansted Airport',              city: 'London',          country: 'GB', lat: 51.89,  lon: 0.24,     population: 9.3,  tier: 'regional' },
  { code: 'MAN', name: 'Manchester Airport',            city: 'Manchester',      country: 'GB', lat: 53.36,  lon: -2.27,    population: 2.8,  tier: 'major'    },
  { code: 'BHX', name: 'Birmingham Airport',            city: 'Birmingham',      country: 'GB', lat: 52.45,  lon: -1.74,    population: 2.6,  tier: 'regional' },
  { code: 'EDI', name: 'Edinburgh Airport',             city: 'Edinburgh',       country: 'GB', lat: 55.95,  lon: -3.37,    population: 0.5,  tier: 'regional' },
  { code: 'GLA', name: 'Glasgow Airport',               city: 'Glasgow',         country: 'GB', lat: 55.87,  lon: -4.43,    population: 1.0,  tier: 'regional' },
  { code: 'BRS', name: 'Bristol Airport',               city: 'Bristol',         country: 'GB', lat: 51.38,  lon: -2.72,    population: 0.7,  tier: 'regional' },
  { code: 'NCL', name: 'Newcastle Airport',             city: 'Newcastle',       country: 'GB', lat: 55.04,  lon: -1.69,    population: 0.9,  tier: 'regional' },
  { code: 'BFS', name: 'Belfast Intl',                  city: 'Belfast',         country: 'GB', lat: 54.66,  lon: -6.22,    population: 0.34, tier: 'regional' },
  { code: 'ORY', name: 'Paris Orly',                    city: 'Paris',           country: 'FR', lat: 48.72,  lon: 2.36,     population: 11.0, tier: 'major'    },
  { code: 'LYS', name: 'Lyon Saint-Exupery',           city: 'Lyon',            country: 'FR', lat: 45.72,  lon: 5.08,     population: 1.7,  tier: 'regional' },
  { code: 'NCE', name: 'Nice Cote d Azur',              city: 'Nice',            country: 'FR', lat: 43.66,  lon: 7.21,     population: 1.0,  tier: 'regional' },
  { code: 'MRS', name: 'Marseille Provence',            city: 'Marseille',       country: 'FR', lat: 43.44,  lon: 5.22,     population: 1.8,  tier: 'regional' },
  { code: 'TLS', name: 'Toulouse Blagnac',              city: 'Toulouse',        country: 'FR', lat: 43.63,  lon: 1.37,     population: 1.0,  tier: 'regional' },
  { code: 'NTE', name: 'Nantes Atlantique',             city: 'Nantes',          country: 'FR', lat: 47.15,  lon: -1.61,    population: 0.9,  tier: 'regional' },
  { code: 'BOD', name: 'Bordeaux Merignac',             city: 'Bordeaux',        country: 'FR', lat: 44.83,  lon: -0.72,    population: 0.9,  tier: 'regional' },
  { code: 'BER', name: 'Berlin Brandenburg',            city: 'Berlin',          country: 'DE', lat: 52.37,  lon: 13.50,    population: 3.8,  tier: 'major'    },
  { code: 'HAM', name: 'Hamburg Airport',               city: 'Hamburg',         country: 'DE', lat: 53.63,  lon: 10.00,    population: 1.8,  tier: 'regional' },
  { code: 'DUS', name: 'Dusseldorf Airport',            city: 'Dusseldorf',      country: 'DE', lat: 51.29,  lon: 6.77,     population: 1.0,  tier: 'regional' },
  { code: 'CGN', name: 'Cologne Bonn Airport',          city: 'Cologne',         country: 'DE', lat: 50.87,  lon: 7.14,     population: 1.1,  tier: 'regional' },
  { code: 'STR', name: 'Stuttgart Airport',             city: 'Stuttgart',       country: 'DE', lat: 48.69,  lon: 9.22,     population: 0.6,  tier: 'regional' },
  { code: 'NUE', name: 'Nuremberg Airport',             city: 'Nuremberg',       country: 'DE', lat: 49.49,  lon: 11.08,    population: 0.5,  tier: 'regional' },
  { code: 'VLC', name: 'Valencia Airport',              city: 'Valencia',        country: 'ES', lat: 39.49,  lon: -0.48,    population: 0.8,  tier: 'regional' },
  { code: 'SVQ', name: 'Sevilla Airport',               city: 'Seville',         country: 'ES', lat: 37.42,  lon: -5.89,    population: 1.5,  tier: 'regional' },
  { code: 'AGP', name: 'Malaga Costa del Sol',          city: 'Malaga',          country: 'ES', lat: 36.67,  lon: -4.50,    population: 0.57, tier: 'regional' },
  { code: 'PMI', name: 'Palma de Mallorca Airport',     city: 'Palma',           country: 'ES', lat: 39.55,  lon: 2.74,     population: 0.47, tier: 'regional' },
  { code: 'TFS', name: 'Tenerife South Airport',        city: 'Tenerife',        country: 'ES', lat: 28.04,  lon: -16.57,   population: 0.9,  tier: 'regional' },
  { code: 'LPA', name: 'Gran Canaria Airport',          city: 'Las Palmas',      country: 'ES', lat: 27.93,  lon: -15.39,   population: 0.38, tier: 'regional' },
  { code: 'IBZ', name: 'Ibiza Airport',                 city: 'Ibiza',           country: 'ES', lat: 38.87,  lon: 1.37,     population: 0.14, tier: 'regional' },
  { code: 'BIO', name: 'Bilbao Airport',                city: 'Bilbao',          country: 'ES', lat: 43.30,  lon: -2.91,    population: 1.0,  tier: 'regional' },
  { code: 'OPO', name: 'Porto Airport',                 city: 'Porto',           country: 'PT', lat: 41.24,  lon: -8.68,    population: 1.7,  tier: 'regional' },
  { code: 'FAO', name: 'Faro Airport',                  city: 'Faro',            country: 'PT', lat: 37.01,  lon: -7.97,    population: 0.12, tier: 'regional' },
  { code: 'FNC', name: 'Madeira Airport',               city: 'Funchal',         country: 'PT', lat: 32.70,  lon: -16.78,   population: 0.11, tier: 'regional' },
  { code: 'NAP', name: 'Naples Intl',                   city: 'Naples',          country: 'IT', lat: 40.89,  lon: 14.29,    population: 3.1,  tier: 'regional' },
  { code: 'VCE', name: 'Venice Marco Polo',             city: 'Venice',          country: 'IT', lat: 45.50,  lon: 12.35,    population: 0.26, tier: 'regional' },
  { code: 'BLQ', name: 'Bologna Guglielmo Marconi',     city: 'Bologna',         country: 'IT', lat: 44.53,  lon: 11.29,    population: 0.39, tier: 'regional' },
  { code: 'CTA', name: 'Catania Fontanarossa',          city: 'Catania',         country: 'IT', lat: 37.47,  lon: 15.07,    population: 0.31, tier: 'regional' },
  { code: 'PMO', name: 'Falcone Borsellino Airport',    city: 'Palermo',         country: 'IT', lat: 38.18,  lon: 13.09,    population: 0.67, tier: 'regional' },
  { code: 'PSA', name: 'Pisa Galileo Galilei',          city: 'Pisa',            country: 'IT', lat: 43.68,  lon: 10.39,    population: 0.09, tier: 'regional' },
  { code: 'LIN', name: 'Milan Linate',                  city: 'Milan',           country: 'IT', lat: 45.45,  lon: 9.28,     population: 3.2,  tier: 'regional' },
  { code: 'TRN', name: 'Turin Caselle Airport',         city: 'Turin',           country: 'IT', lat: 45.20,  lon: 7.65,     population: 0.87, tier: 'regional' },
  { code: 'PRG', name: 'Vaclav Havel Airport Prague',   city: 'Prague',          country: 'CZ', lat: 50.10,  lon: 14.26,    population: 1.3,  tier: 'regional' },
  { code: 'BUD', name: 'Budapest Ferenc Liszt Intl',    city: 'Budapest',        country: 'HU', lat: 47.43,  lon: 19.26,    population: 1.8,  tier: 'regional' },
  { code: 'OTP', name: 'Henri Coanda Intl',             city: 'Bucharest',       country: 'RO', lat: 44.57,  lon: 26.10,    population: 2.3,  tier: 'regional' },
  { code: 'SOF', name: 'Sofia Airport',                 city: 'Sofia',           country: 'BG', lat: 42.70,  lon: 23.41,    population: 1.3,  tier: 'regional' },
  { code: 'ZAG', name: 'Zagreb Airport',                city: 'Zagreb',          country: 'HR', lat: 45.74,  lon: 16.07,    population: 0.8,  tier: 'regional' },
  { code: 'DBV', name: 'Dubrovnik Airport',             city: 'Dubrovnik',       country: 'HR', lat: 42.56,  lon: 18.27,    population: 0.04, tier: 'regional' },
  { code: 'SPU', name: 'Split Airport',                 city: 'Split',           country: 'HR', lat: 43.54,  lon: 16.30,    population: 0.18, tier: 'regional' },
  { code: 'BEG', name: 'Belgrade Nikola Tesla Airport', city: 'Belgrade',        country: 'RS', lat: 44.82,  lon: 20.31,    population: 1.7,  tier: 'regional' },
  { code: 'LJU', name: 'Ljubljana Joze Pucnik Airport', city: 'Ljubljana',       country: 'SI', lat: 46.22,  lon: 14.46,    population: 0.27, tier: 'regional' },
  { code: 'SKP', name: 'Skopje Intl',                   city: 'Skopje',          country: 'MK', lat: 41.96,  lon: 21.62,    population: 0.54, tier: 'regional' },
  { code: 'TIA', name: 'Tirana Rinas Mother Teresa',    city: 'Tirana',          country: 'AL', lat: 41.41,  lon: 19.72,    population: 0.5,  tier: 'regional' },
  { code: 'BTS', name: 'Bratislava Airport',            city: 'Bratislava',      country: 'SK', lat: 48.17,  lon: 17.21,    population: 0.48, tier: 'regional' },
  { code: 'KBP', name: 'Kyiv Boryspil Intl',           city: 'Kyiv',            country: 'UA', lat: 50.35,  lon: 30.89,    population: 3.1,  tier: 'regional' },
  { code: 'LWO', name: 'Lviv Danylo Halytskyi Intl',   city: 'Lviv',            country: 'UA', lat: 49.81,  lon: 23.96,    population: 0.72, tier: 'regional' },
  { code: 'MSQ', name: 'Minsk National Airport',        city: 'Minsk',           country: 'BY', lat: 53.88,  lon: 28.03,    population: 2.0,  tier: 'regional' },
  { code: 'TLL', name: 'Tallinn Airport',               city: 'Tallinn',         country: 'EE', lat: 59.41,  lon: 24.83,    population: 0.44, tier: 'regional' },
  { code: 'RIX', name: 'Riga Intl',                     city: 'Riga',            country: 'LV', lat: 56.92,  lon: 23.97,    population: 0.63, tier: 'regional' },
  { code: 'VNO', name: 'Vilnius Airport',               city: 'Vilnius',         country: 'LT', lat: 54.63,  lon: 25.29,    population: 0.57, tier: 'regional' },
  { code: 'SVO', name: 'Moscow Sheremetyevo Intl',      city: 'Moscow',          country: 'RU', lat: 55.97,  lon: 37.41,    population: 12.4, tier: 'mega'     },
  { code: 'DME', name: 'Moscow Domodedovo Intl',        city: 'Moscow',          country: 'RU', lat: 55.41,  lon: 37.90,    population: 12.4, tier: 'major'    },
  { code: 'LED', name: 'St. Petersburg Pulkovo',        city: 'St. Petersburg',  country: 'RU', lat: 59.80,  lon: 30.26,    population: 5.4,  tier: 'regional' },
  { code: 'AER', name: 'Sochi Intl',                    city: 'Sochi',           country: 'RU', lat: 43.45,  lon: 39.96,    population: 0.4,  tier: 'regional' },
  { code: 'SVX', name: 'Yekaterinburg Koltsovo',        city: 'Yekaterinburg',   country: 'RU', lat: 56.84,  lon: 60.80,    population: 1.5,  tier: 'regional' },
  { code: 'OVB', name: 'Novosibirsk Tolmachevo',        city: 'Novosibirsk',     country: 'RU', lat: 54.97,  lon: 82.65,    population: 1.6,  tier: 'regional' },
  { code: 'VKO', name: 'Moscow Vnukovo',                city: 'Moscow',          country: 'RU', lat: 55.60,  lon: 37.26,    population: 12.4, tier: 'major'    },
  { code: 'KEF', name: 'Keflavik Intl',                 city: 'Reykjavik',       country: 'IS', lat: 63.99,  lon: -22.62,   population: 0.22, tier: 'regional', visitors: 2.0, gateway: 0.15 },
  { code: 'GOT', name: 'Gothenburg Landvetter',         city: 'Gothenburg',      country: 'SE', lat: 57.66,  lon: 12.29,    population: 0.57, tier: 'regional' },
  { code: 'BGO', name: 'Bergen Flesland',               city: 'Bergen',          country: 'NO', lat: 60.29,  lon: 5.22,     population: 0.28, tier: 'regional' },
  { code: 'TRD', name: 'Trondheim Vaernes',             city: 'Trondheim',       country: 'NO', lat: 63.46,  lon: 10.92,    population: 0.19, tier: 'regional' },
  { code: 'AAL', name: 'Aalborg Airport',               city: 'Aalborg',         country: 'DK', lat: 57.09,  lon: 9.85,     population: 0.12, tier: 'regional' },
  { code: 'HER', name: 'Heraklion Nikos Kazantzakis',   city: 'Heraklion',       country: 'GR', lat: 35.34,  lon: 25.18,    population: 0.17, tier: 'regional' },
  { code: 'RHO', name: 'Rhodes Diagoras Airport',       city: 'Rhodes',          country: 'GR', lat: 36.41,  lon: 28.08,    population: 0.12, tier: 'regional' },
  { code: 'JTR', name: 'Santorini Thira Airport',       city: 'Santorini',       country: 'GR', lat: 36.40,  lon: 25.48,    population: 0.02, tier: 'regional' },
  { code: 'JMK', name: 'Mykonos Airport',               city: 'Mykonos',         country: 'GR', lat: 37.43,  lon: 25.35,    population: 0.01, tier: 'regional' },
  { code: 'CHQ', name: 'Chania Intl',                   city: 'Chania',          country: 'GR', lat: 35.53,  lon: 24.15,    population: 0.11, tier: 'regional' },
  { code: 'SKG', name: 'Thessaloniki Macedonia Airport',city: 'Thessaloniki',    country: 'GR', lat: 40.52,  lon: 22.97,    population: 1.1,  tier: 'regional' },
  { code: 'AYT', name: 'Antalya Airport',               city: 'Antalya',         country: 'TR', lat: 36.90,  lon: 30.80,    population: 2.4,  tier: 'regional' },
  { code: 'ADB', name: 'Izmir Adnan Menderes',          city: 'Izmir',           country: 'TR', lat: 38.29,  lon: 27.16,    population: 4.3,  tier: 'regional' },
  { code: 'ESB', name: 'Ankara Esenboga Intl',          city: 'Ankara',          country: 'TR', lat: 40.13,  lon: 32.99,    population: 5.7,  tier: 'regional' },
  { code: 'DLM', name: 'Dalaman Airport',               city: 'Dalaman',         country: 'TR', lat: 36.71,  lon: 28.79,    population: 0.08, tier: 'regional' },
  { code: 'SAW', name: 'Istanbul Sabiha Gokcen Intl',   city: 'Istanbul',        country: 'TR', lat: 40.90,  lon: 29.31,    population: 15.6, tier: 'major'    },

  // ── MIDDLE EAST (additional) ─────────────────────────────────────────────────
  { code: 'JED', name: 'King Abdulaziz Intl',           city: 'Jeddah',          country: 'SA', lat: 21.66,  lon: 39.16,    population: 4.8,  tier: 'major'    },
  { code: 'DMM', name: 'King Fahd Intl',                city: 'Dammam',          country: 'SA', lat: 26.47,  lon: 49.80,    population: 1.2,  tier: 'regional' },
  { code: 'MED', name: 'Prince Mohammad bin Abdulaziz', city: 'Medina',          country: 'SA', lat: 24.55,  lon: 39.71,    population: 1.5,  tier: 'regional' },
  { code: 'KWI', name: 'Kuwait Intl',                   city: 'Kuwait City',     country: 'KW', lat: 29.23,  lon: 47.97,    population: 3.1,  tier: 'regional' },
  { code: 'BAH', name: 'Bahrain Intl',                  city: 'Manama',          country: 'BH', lat: 26.27,  lon: 50.63,    population: 0.63, tier: 'regional' },
  { code: 'MCT', name: 'Muscat Intl',                   city: 'Muscat',          country: 'OM', lat: 23.59,  lon: 58.28,    population: 1.6,  tier: 'regional' },
  { code: 'SHJ', name: 'Sharjah Intl',                  city: 'Sharjah',         country: 'AE', lat: 25.33,  lon: 55.52,    population: 1.4,  tier: 'regional' },
  { code: 'BEY', name: 'Beirut Rafic Hariri Intl',      city: 'Beirut',          country: 'LB', lat: 33.82,  lon: 35.49,    population: 2.2,  tier: 'regional' },
  { code: 'AMM', name: 'Queen Alia Intl',               city: 'Amman',           country: 'JO', lat: 31.72,  lon: 35.99,    population: 2.1,  tier: 'regional' },
  { code: 'BGW', name: 'Baghdad Intl',                  city: 'Baghdad',         country: 'IQ', lat: 33.26,  lon: 44.23,    population: 8.1,  tier: 'regional' },
  { code: 'IKA', name: 'Tehran Imam Khomeini Intl',     city: 'Tehran',          country: 'IR', lat: 35.42,  lon: 51.15,    population: 15.8, tier: 'major'    },
  { code: 'MHD', name: 'Mashhad Shahid Hasheminejad',   city: 'Mashhad',         country: 'IR', lat: 36.24,  lon: 59.64,    population: 3.4,  tier: 'regional' },
  { code: 'GYD', name: 'Heydar Aliyev Intl',            city: 'Baku',            country: 'AZ', lat: 40.47,  lon: 50.04,    population: 2.3,  tier: 'regional' },
  { code: 'TBS', name: 'Tbilisi Intl',                  city: 'Tbilisi',         country: 'GE', lat: 41.67,  lon: 44.95,    population: 1.2,  tier: 'regional' },
  { code: 'EVN', name: 'Zvartnots Intl',                city: 'Yerevan',         country: 'AM', lat: 40.15,  lon: 44.40,    population: 1.2,  tier: 'regional' },
  { code: 'TAS', name: 'Tashkent Yunus Akhunbabayev',   city: 'Tashkent',        country: 'UZ', lat: 41.26,  lon: 69.28,    population: 2.9,  tier: 'regional' },
  { code: 'ALA', name: 'Almaty Intl',                   city: 'Almaty',          country: 'KZ', lat: 43.35,  lon: 77.04,    population: 2.0,  tier: 'regional' },
  { code: 'NQZ', name: 'Astana Intl',                   city: 'Nur-Sultan',      country: 'KZ', lat: 51.02,  lon: 71.47,    population: 1.2,  tier: 'regional' },
  { code: 'FRU', name: 'Manas Intl',                    city: 'Bishkek',         country: 'KG', lat: 43.06,  lon: 74.48,    population: 1.1,  tier: 'regional' },
  { code: 'ASB', name: 'Ashgabat Intl',                 city: 'Ashgabat',        country: 'TM', lat: 37.99,  lon: 58.36,    population: 0.9,  tier: 'regional' },
  { code: 'DYU', name: 'Dushanbe Intl',                 city: 'Dushanbe',        country: 'TJ', lat: 38.54,  lon: 68.82,    population: 0.8,  tier: 'regional' },
  { code: 'KBL', name: 'Hamid Karzai Intl',             city: 'Kabul',           country: 'AF', lat: 34.56,  lon: 69.21,    population: 4.6,  tier: 'regional' },
  { code: 'KHI', name: 'Jinnah Intl',                   city: 'Karachi',         country: 'PK', lat: 24.91,  lon: 67.16,    population: 16.1, tier: 'major'    },
  { code: 'LHE', name: 'Allama Iqbal Intl',             city: 'Lahore',          country: 'PK', lat: 31.52,  lon: 74.40,    population: 13.1, tier: 'major'    },
  { code: 'ISB', name: 'Islamabad Intl',                city: 'Islamabad',       country: 'PK', lat: 33.55,  lon: 72.84,    population: 2.2,  tier: 'regional' },

  // ── AFRICA (additional) ──────────────────────────────────────────────────────
  { code: 'ALG', name: 'Houari Boumediene Airport',     city: 'Algiers',         country: 'DZ', lat: 36.69,  lon: 3.22,     population: 3.4,  tier: 'regional' },
  { code: 'TUN', name: 'Tunis Carthage Intl',           city: 'Tunis',           country: 'TN', lat: 36.85,  lon: 10.23,    population: 2.5,  tier: 'regional' },
  { code: 'TIP', name: 'Tripoli Intl',                  city: 'Tripoli',         country: 'LY', lat: 32.66,  lon: 13.15,    population: 1.2,  tier: 'regional' },
  { code: 'KRT', name: 'Khartoum Intl',                 city: 'Khartoum',        country: 'SD', lat: 15.60,  lon: 32.55,    population: 6.2,  tier: 'regional' },
  { code: 'HRG', name: 'Hurghada Intl',                 city: 'Hurghada',        country: 'EG', lat: 27.18,  lon: 33.80,    population: 0.25, tier: 'regional' },
  { code: 'SSH', name: 'Sharm el-Sheikh Intl',          city: 'Sharm el-Sheikh', country: 'EG', lat: 27.98,  lon: 34.40,    population: 0.06, tier: 'regional' },
  { code: 'ABV', name: 'Nnamdi Azikiwe Intl',           city: 'Abuja',           country: 'NG', lat: 9.01,   lon: 7.26,     population: 3.6,  tier: 'regional' },
  { code: 'PHC', name: 'Port Harcourt Intl',            city: 'Port Harcourt',   country: 'NG', lat: 5.01,   lon: 6.95,     population: 2.7,  tier: 'regional' },
  { code: 'ACC', name: 'Kotoka Intl',                   city: 'Accra',           country: 'GH', lat: 5.60,   lon: -0.17,    population: 3.6,  tier: 'regional' },
  { code: 'ABJ', name: 'Felix Houphouet-Boigny Intl',   city: 'Abidjan',         country: 'CI', lat: 5.26,   lon: -3.93,    population: 5.2,  tier: 'regional' },
  { code: 'DKR', name: 'Blaise Diagne Intl',            city: 'Dakar',           country: 'SN', lat: 14.67,  lon: -17.07,   population: 3.7,  tier: 'regional' },
  { code: 'BKO', name: 'Senou Intl',                    city: 'Bamako',          country: 'ML', lat: 12.53,  lon: -7.95,    population: 2.7,  tier: 'regional' },
  { code: 'OUA', name: 'Ouagadougou Airport',           city: 'Ouagadougou',     country: 'BF', lat: 12.35,  lon: -1.51,    population: 2.7,  tier: 'regional' },
  { code: 'NIM', name: 'Diori Hamani Intl',             city: 'Niamey',          country: 'NE', lat: 13.48,  lon: 2.18,     population: 1.3,  tier: 'regional' },
  { code: 'NDJ', name: 'Hassan Djamous Intl',           city: "N'Djamena",       country: 'TD', lat: 12.13,  lon: 15.03,    population: 1.4,  tier: 'regional' },
  { code: 'LFW', name: 'Lome Tokoin Airport',           city: 'Lome',            country: 'TG', lat: 6.17,   lon: 1.25,     population: 1.5,  tier: 'regional' },
  { code: 'COO', name: 'Cadjehoun Airport',             city: 'Cotonou',         country: 'BJ', lat: 6.36,   lon: 2.38,     population: 0.76, tier: 'regional' },
  { code: 'FIH', name: 'N\'Djili Intl',                 city: 'Kinshasa',        country: 'CD', lat: -4.39,  lon: 15.44,    population: 14.3, tier: 'major'    },
  { code: 'DLA', name: 'Douala Intl',                   city: 'Douala',          country: 'CM', lat: 4.01,   lon: 9.72,     population: 3.8,  tier: 'regional' },
  { code: 'YAO', name: 'Yaounde Nsimalen Intl',         city: 'Yaounde',         country: 'CM', lat: 3.72,   lon: 11.55,    population: 2.9,  tier: 'regional' },
  { code: 'LBV', name: 'Leon M\'Ba Intl',               city: 'Libreville',      country: 'GA', lat: 0.46,   lon: 9.41,     population: 0.70, tier: 'regional' },
  { code: 'BZV', name: 'Maya-Maya Airport',             city: 'Brazzaville',     country: 'CG', lat: -4.25,  lon: 15.25,    population: 2.3,  tier: 'regional' },
  { code: 'DAR', name: 'Julius Nyerere Intl',           city: 'Dar es Salaam',   country: 'TZ', lat: -6.88,  lon: 39.20,    population: 6.7,  tier: 'regional' },
  { code: 'JRO', name: 'Kilimanjaro Intl',              city: 'Arusha',          country: 'TZ', lat: -3.43,  lon: 37.07,    population: 0.42, tier: 'regional' },
  { code: 'EBB', name: 'Entebbe Intl',                  city: 'Kampala',         country: 'UG', lat: 0.04,   lon: 32.44,    population: 3.6,  tier: 'regional' },
  { code: 'KGL', name: 'Kigali Intl',                   city: 'Kigali',          country: 'RW', lat: -1.97,  lon: 30.14,    population: 1.1,  tier: 'regional' },
  { code: 'HRE', name: 'Robert Gabriel Mugabe Intl',    city: 'Harare',          country: 'ZW', lat: -17.93, lon: 31.10,    population: 2.2,  tier: 'regional' },
  { code: 'LLW', name: 'Kamuzu Intl',                   city: 'Lilongwe',        country: 'MW', lat: -13.79, lon: 33.78,    population: 0.99, tier: 'regional' },
  { code: 'MPM', name: 'Maputo Intl',                   city: 'Maputo',          country: 'MZ', lat: -25.92, lon: 32.57,    population: 1.8,  tier: 'regional' },
  { code: 'WDH', name: 'Hosea Kutako Intl',             city: 'Windhoek',        country: 'NA', lat: -22.48, lon: 17.47,    population: 0.43, tier: 'regional' },
  { code: 'GBE', name: 'Sir Seretse Khama Intl',        city: 'Gaborone',        country: 'BW', lat: -24.56, lon: 25.92,    population: 0.27, tier: 'regional' },
  { code: 'TNR', name: 'Ivato Intl',                    city: 'Antananarivo',    country: 'MG', lat: -18.80, lon: 47.48,    population: 3.6,  tier: 'regional' },
  { code: 'MRU', name: 'Sir Seewoosagur Ramgoolam Intl',city: 'Port Louis',      country: 'MU', lat: -20.43, lon: 57.68,    population: 0.15, tier: 'regional' },
  { code: 'DUR', name: 'King Shaka Intl',               city: 'Durban',          country: 'ZA', lat: -29.61, lon: 31.12,    population: 3.7,  tier: 'regional' },
  { code: 'LUN', name: 'Kenneth Kaunda Intl',           city: 'Lusaka',          country: 'ZM', lat: -15.33, lon: 28.45,    population: 2.5,  tier: 'regional' },

  // ── SOUTH ASIA (additional) ──────────────────────────────────────────────────
  { code: 'HYD', name: 'Rajiv Gandhi Intl',             city: 'Hyderabad',       country: 'IN', lat: 17.23,  lon: 78.43,    population: 10.5, tier: 'major'    },
  { code: 'MAA', name: 'Chennai Intl',                  city: 'Chennai',         country: 'IN', lat: 12.99,  lon: 80.18,    population: 10.9, tier: 'major'    },
  { code: 'CCU', name: 'Netaji Subhas Chandra Bose Intl',city: 'Kolkata',        country: 'IN', lat: 22.65,  lon: 88.45,    population: 14.9, tier: 'major'    },
  { code: 'AMD', name: 'Sardar Vallabhbhai Patel Intl', city: 'Ahmedabad',       country: 'IN', lat: 23.07,  lon: 72.63,    population: 8.0,  tier: 'regional' },
  { code: 'PNQ', name: 'Pune Airport',                  city: 'Pune',            country: 'IN', lat: 18.58,  lon: 73.92,    population: 7.4,  tier: 'regional' },
  { code: 'GOI', name: 'Goa Dabolim Airport',           city: 'Goa',             country: 'IN', lat: 15.38,  lon: 73.83,    population: 0.11, tier: 'regional' },
  { code: 'COK', name: 'Cochin Intl',                   city: 'Kochi',           country: 'IN', lat: 10.15,  lon: 76.40,    population: 2.1,  tier: 'regional' },
  { code: 'JAI', name: 'Jaipur Intl',                   city: 'Jaipur',          country: 'IN', lat: 26.82,  lon: 75.81,    population: 3.1,  tier: 'regional' },
  { code: 'LKO', name: 'Chaudhary Charan Singh Intl',   city: 'Lucknow',         country: 'IN', lat: 26.76,  lon: 80.89,    population: 3.5,  tier: 'regional' },
  { code: 'KTM', name: 'Tribhuvan Intl',                city: 'Kathmandu',       country: 'NP', lat: 27.70,  lon: 85.36,    population: 1.4,  tier: 'regional' },
  { code: 'DAC', name: 'Hazrat Shahjalal Intl',         city: 'Dhaka',           country: 'BD', lat: 23.84,  lon: 90.40,    population: 22.5, tier: 'major'    },
  { code: 'CGP', name: 'Shah Amanat Intl',              city: 'Chittagong',      country: 'BD', lat: 22.25,  lon: 91.81,    population: 5.0,  tier: 'regional' },
  { code: 'RGN', name: 'Yangon Intl',                   city: 'Yangon',          country: 'MM', lat: 16.91,  lon: 96.13,    population: 7.4,  tier: 'regional' },
  { code: 'HAN', name: 'Noi Bai Intl',                  city: 'Hanoi',           country: 'VN', lat: 21.22,  lon: 105.81,   population: 8.5,  tier: 'major'    },
  { code: 'SGN', name: 'Tan Son Nhat Intl',             city: 'Ho Chi Minh City',country: 'VN', lat: 10.82,  lon: 106.66,   population: 13.0, tier: 'major'    },
  { code: 'DAD', name: 'Da Nang Intl',                  city: 'Da Nang',         country: 'VN', lat: 16.04,  lon: 108.20,   population: 1.2,  tier: 'regional' },
  { code: 'PNH', name: 'Phnom Penh Intl',               city: 'Phnom Penh',      country: 'KH', lat: 11.55,  lon: 104.84,   population: 2.3,  tier: 'regional' },
  { code: 'REP', name: 'Siem Reap Intl',                city: 'Siem Reap',       country: 'KH', lat: 13.41,  lon: 103.81,   population: 0.25, tier: 'regional' },
  { code: 'VTE', name: 'Wattay Intl',                   city: 'Vientiane',       country: 'LA', lat: 17.99,  lon: 102.56,   population: 0.96, tier: 'regional' },

  // ── SOUTHEAST ASIA (additional) ──────────────────────────────────────────────
  { code: 'DPS', name: 'Ngurah Rai Intl',               city: 'Bali',            country: 'ID', lat: -8.75,  lon: 115.17,   population: 1.7,  tier: 'major'    },
  { code: 'SUB', name: 'Juanda Intl',                   city: 'Surabaya',        country: 'ID', lat: -7.38,  lon: 112.79,   population: 9.7,  tier: 'major'    },
  { code: 'UPG', name: 'Sultan Hasanuddin Intl',        city: 'Makassar',        country: 'ID', lat: -5.06,  lon: 119.55,   population: 1.9,  tier: 'regional' },
  { code: 'KNO', name: 'Kuala Namu Intl',               city: 'Medan',           country: 'ID', lat: 3.64,   lon: 98.89,    population: 4.1,  tier: 'regional' },
  { code: 'BPN', name: 'Sultan Aji Muhammad Sulaiman',  city: 'Balikpapan',      country: 'ID', lat: -1.27,  lon: 116.89,   population: 0.8,  tier: 'regional' },
  { code: 'PEN', name: 'Penang Intl',                   city: 'Penang',          country: 'MY', lat: 5.30,   lon: 100.28,   population: 1.8,  tier: 'regional' },
  { code: 'BKI', name: 'Kota Kinabalu Intl',            city: 'Kota Kinabalu',   country: 'MY', lat: 5.94,   lon: 116.05,   population: 0.72, tier: 'regional' },
  { code: 'KCH', name: 'Kuching Intl',                  city: 'Kuching',         country: 'MY', lat: 1.48,   lon: 110.34,   population: 0.73, tier: 'regional' },
  { code: 'JHB', name: 'Senai Intl',                    city: 'Johor Bahru',     country: 'MY', lat: 1.64,   lon: 103.67,   population: 1.8,  tier: 'regional' },
  { code: 'BWN', name: 'Brunei Intl',                   city: 'Bandar Seri Begawan', country: 'BN', lat: 4.94, lon: 114.93,  population: 0.28, tier: 'regional' },
  { code: 'CEB', name: 'Mactan-Cebu Intl',              city: 'Cebu',            country: 'PH', lat: 10.31,  lon: 123.98,   population: 2.9,  tier: 'regional' },
  { code: 'DVO', name: 'Francisco Bangoy Intl',         city: 'Davao',           country: 'PH', lat: 7.13,   lon: 125.65,   population: 2.1,  tier: 'regional' },
  { code: 'ILO', name: 'Iloilo Intl',                   city: 'Iloilo',          country: 'PH', lat: 10.83,  lon: 122.49,   population: 1.0,  tier: 'regional' },
  { code: 'DMK', name: 'Don Mueang Intl',               city: 'Bangkok',         country: 'TH', lat: 13.91,  lon: 100.61,   population: 15.7, tier: 'major'    },
  { code: 'CNX', name: 'Chiang Mai Intl',               city: 'Chiang Mai',      country: 'TH', lat: 18.77,  lon: 98.96,    population: 1.0,  tier: 'regional' },
  { code: 'HKT', name: 'Phuket Intl',                   city: 'Phuket',          country: 'TH', lat: 8.11,   lon: 98.32,    population: 0.38, tier: 'regional' },
  { code: 'USM', name: 'Samui Airport',                 city: 'Ko Samui',        country: 'TH', lat: 9.55,   lon: 100.06,   population: 0.06, tier: 'regional' },

  // ── EAST ASIA (additional) ───────────────────────────────────────────────────
  { code: 'PKX', name: 'Beijing Daxing Intl',           city: 'Beijing',         country: 'CN', lat: 39.51,  lon: 116.41,   population: 21.5, tier: 'mega'     },
  { code: 'SHA', name: 'Shanghai Hongqiao Intl',        city: 'Shanghai',        country: 'CN', lat: 31.20,  lon: 121.34,   population: 27.1, tier: 'major'    },
  { code: 'CKG', name: 'Chongqing Jiangbei Intl',       city: 'Chongqing',       country: 'CN', lat: 29.72,  lon: 106.64,   population: 8.8,  tier: 'major'    },
  { code: 'WUH', name: 'Wuhan Tianhe Intl',             city: 'Wuhan',           country: 'CN', lat: 30.78,  lon: 114.21,   population: 8.2,  tier: 'major'    },
  { code: 'XIY', name: "Xi'an Xianyang Intl",           city: "Xi'an",           country: 'CN', lat: 34.45,  lon: 108.75,   population: 8.1,  tier: 'major'    },
  { code: 'KMG', name: 'Kunming Changshui Intl',        city: 'Kunming',         country: 'CN', lat: 25.10,  lon: 102.93,   population: 7.2,  tier: 'major'    },
  { code: 'HGH', name: 'Hangzhou Xiaoshan Intl',        city: 'Hangzhou',        country: 'CN', lat: 30.23,  lon: 120.43,   population: 7.8,  tier: 'major'    },
  { code: 'NKG', name: 'Nanjing Lukou Intl',            city: 'Nanjing',         country: 'CN', lat: 31.74,  lon: 118.87,   population: 8.5,  tier: 'major'    },
  { code: 'XMN', name: 'Xiamen Gaoqi Intl',             city: 'Xiamen',          country: 'CN', lat: 24.54,  lon: 118.13,   population: 4.9,  tier: 'regional' },
  { code: 'TAO', name: 'Qingdao Jiaodong Intl',         city: 'Qingdao',         country: 'CN', lat: 36.36,  lon: 120.31,   population: 9.4,  tier: 'regional' },
  { code: 'HRB', name: 'Harbin Taiping Intl',           city: 'Harbin',          country: 'CN', lat: 45.62,  lon: 126.25,   population: 5.3,  tier: 'regional' },
  { code: 'SHE', name: 'Shenyang Taoxian Intl',         city: 'Shenyang',        country: 'CN', lat: 41.64,  lon: 123.49,   population: 6.9,  tier: 'regional' },
  { code: 'DLC', name: 'Dalian Zhoushuizi Intl',        city: 'Dalian',          country: 'CN', lat: 38.97,  lon: 121.54,   population: 3.4,  tier: 'regional' },
  { code: 'TNA', name: 'Jinan Yaoqiang Intl',           city: 'Jinan',           country: 'CN', lat: 36.86,  lon: 117.22,   population: 7.4,  tier: 'regional' },
  { code: 'CSX', name: 'Changsha Huanghua Intl',        city: 'Changsha',        country: 'CN', lat: 28.19,  lon: 113.22,   population: 8.0,  tier: 'regional' },
  { code: 'NNG', name: 'Nanning Wuxu Intl',             city: 'Nanning',         country: 'CN', lat: 22.61,  lon: 108.17,   population: 4.9,  tier: 'regional' },
  { code: 'URC', name: 'Urumqi Diwopu Intl',            city: 'Urumqi',          country: 'CN', lat: 43.91,  lon: 87.47,    population: 3.5,  tier: 'regional' },
  { code: 'MFM', name: 'Macau Intl',                    city: 'Macau',           country: 'MO', lat: 22.15,  lon: 113.59,   population: 0.68, tier: 'regional' },
  { code: 'GMP', name: 'Seoul Gimpo Intl',              city: 'Seoul',           country: 'KR', lat: 37.56,  lon: 126.80,   population: 9.8,  tier: 'major'    },
  { code: 'PUS', name: 'Gimhae Intl',                   city: 'Busan',           country: 'KR', lat: 35.18,  lon: 128.94,   population: 3.4,  tier: 'regional' },
  { code: 'CJU', name: 'Jeju Intl',                     city: 'Jeju',            country: 'KR', lat: 33.51,  lon: 126.49,   population: 0.67, tier: 'regional' },
  { code: 'TAE', name: 'Daegu Intl',                    city: 'Daegu',           country: 'KR', lat: 35.90,  lon: 128.66,   population: 2.5,  tier: 'regional' },
  { code: 'CTS', name: 'New Chitose Airport',           city: 'Sapporo',         country: 'JP', lat: 42.77,  lon: 141.69,   population: 2.7,  tier: 'regional' },
  { code: 'NGO', name: 'Chubu Centrair Intl',           city: 'Nagoya',          country: 'JP', lat: 34.86,  lon: 136.81,   population: 9.1,  tier: 'major'    },
  { code: 'ITM', name: 'Osaka Itami Airport',           city: 'Osaka',           country: 'JP', lat: 34.78,  lon: 135.44,   population: 19.3, tier: 'major'    },
  { code: 'OKA', name: 'Naha Airport',                  city: 'Okinawa',         country: 'JP', lat: 26.20,  lon: 127.65,   population: 0.32, tier: 'regional' },
  { code: 'SDJ', name: 'Sendai Airport',                city: 'Sendai',          country: 'JP', lat: 38.14,  lon: 140.92,   population: 1.1,  tier: 'regional' },
  { code: 'FUK', name: 'Fukuoka Airport',               city: 'Fukuoka',         country: 'JP', lat: 33.58,  lon: 130.45,   population: 2.7,  tier: 'regional' },
  { code: 'KHH', name: 'Kaohsiung Intl',                city: 'Kaohsiung',       country: 'TW', lat: 22.58,  lon: 120.35,   population: 2.8,  tier: 'regional' },
  { code: 'TSA', name: 'Taipei Songshan Airport',       city: 'Taipei',          country: 'TW', lat: 25.07,  lon: 121.55,   population: 7.0,  tier: 'regional' },
  { code: 'RMQ', name: 'Taichung Intl',                 city: 'Taichung',        country: 'TW', lat: 24.26,  lon: 120.62,   population: 2.8,  tier: 'regional' },

  // ── OCEANIA (additional) ─────────────────────────────────────────────────────
  { code: 'PER', name: 'Perth Airport',                 city: 'Perth',           country: 'AU', lat: -31.94, lon: 115.97,   population: 2.1,  tier: 'major'    },
  { code: 'ADL', name: 'Adelaide Airport',              city: 'Adelaide',        country: 'AU', lat: -34.95, lon: 138.53,   population: 1.4,  tier: 'regional' },
  { code: 'CBR', name: 'Canberra Airport',              city: 'Canberra',        country: 'AU', lat: -35.31, lon: 149.20,   population: 0.45, tier: 'regional' },
  { code: 'CNS', name: 'Cairns Airport',                city: 'Cairns',          country: 'AU', lat: -16.89, lon: 145.75,   population: 0.25, tier: 'regional' },
  { code: 'OOL', name: 'Gold Coast Airport',            city: 'Gold Coast',      country: 'AU', lat: -28.17, lon: 153.50,   population: 0.69, tier: 'regional' },
  { code: 'HBA', name: 'Hobart Airport',                city: 'Hobart',          country: 'AU', lat: -42.84, lon: 147.51,   population: 0.24, tier: 'regional' },
  { code: 'DRW', name: 'Darwin Intl',                   city: 'Darwin',          country: 'AU', lat: -12.41, lon: 130.88,   population: 0.15, tier: 'regional' },
  { code: 'CHC', name: 'Christchurch Intl',             city: 'Christchurch',    country: 'NZ', lat: -43.49, lon: 172.53,   population: 0.40, tier: 'regional' },
  { code: 'WLG', name: 'Wellington Intl',               city: 'Wellington',      country: 'NZ', lat: -41.33, lon: 174.81,   population: 0.42, tier: 'regional' },
  { code: 'ZQN', name: 'Queenstown Airport',            city: 'Queenstown',      country: 'NZ', lat: -45.02, lon: 168.74,   population: 0.04, tier: 'regional' },
  { code: 'PPT', name: 'Faa\'a Intl',                   city: 'Papeete',         country: 'PF', lat: -17.55, lon: -149.61,  population: 0.19, tier: 'regional' },
  { code: 'NOU', name: 'La Tontouta Intl',              city: 'Noumea',          country: 'NC', lat: -22.01, lon: 166.21,   population: 0.18, tier: 'regional' },
  { code: 'NAN', name: 'Nadi Intl',                     city: 'Nadi',            country: 'FJ', lat: -17.76, lon: 177.44,   population: 0.10, tier: 'regional' },
  { code: 'SUV', name: 'Nausori Intl',                  city: 'Suva',            country: 'FJ', lat: -18.04, lon: 178.56,   population: 0.09, tier: 'regional' },
  { code: 'POM', name: 'Jacksons Intl',                 city: 'Port Moresby',    country: 'PG', lat: -9.44,  lon: 147.22,   population: 0.37, tier: 'regional' },
  { code: 'HIR', name: 'Honiara Intl',                  city: 'Honiara',         country: 'SB', lat: -9.43,  lon: 160.05,   population: 0.08, tier: 'regional' },
  { code: 'VLI', name: 'Bauerfield Intl',               city: 'Port Vila',       country: 'VU', lat: -17.70, lon: 168.32,   population: 0.05, tier: 'regional' },
  { code: 'GUM', name: 'Antonio B. Won Pat Intl',       city: 'Hagatna',         country: 'GU', lat: 13.48,  lon: 144.80,   population: 0.17, tier: 'regional' },
  { code: 'RAR', name: 'Rarotonga Intl',                city: 'Avarua',          country: 'CK', lat: -21.20, lon: -159.81,  population: 0.02, tier: 'regional' },
  // ── ADDITIONAL AIRPORTS ─────────────────────────────────────────────────────
  { code: 'ALB', name: 'Albany Intl', city: 'Albany', country: 'US', lat: 42.75, lon: -73.8, population: 0.9, tier: 'regional' },
  { code: 'AMA', name: 'Rick Husband Amarillo Intl', city: 'Amarillo', country: 'US', lat: 35.22, lon: -101.71, population: 0.3, tier: 'regional' },
  { code: 'ASE', name: 'Aspen/Pitkin County Airport', city: 'Aspen', country: 'US', lat: 39.22, lon: -106.87, population: 0.07, tier: 'regional' },
  { code: 'AVL', name: 'Asheville Regional', city: 'Asheville', country: 'US', lat: 35.44, lon: -82.54, population: 0.5, tier: 'regional' },
  { code: 'AVP', name: 'Wilkes-Barre/Scranton Intl', city: 'Scranton', country: 'US', lat: 41.34, lon: -75.72, population: 0.6, tier: 'regional' },
  { code: 'AZO', name: 'Kalamazoo/Battle Creek Intl', city: 'Kalamazoo', country: 'US', lat: 42.23, lon: -85.55, population: 0.5, tier: 'regional' },
  { code: 'BFL', name: 'Meadows Field', city: 'Bakersfield', country: 'US', lat: 35.43, lon: -119.06, population: 0.9, tier: 'regional' },
  { code: 'BGM', name: 'Greater Binghamton Airport', city: 'Binghamton', country: 'US', lat: 42.21, lon: -75.98, population: 0.2, tier: 'regional' },
  { code: 'BIL', name: 'Billings Logan Intl', city: 'Billings', country: 'US', lat: 45.81, lon: -108.54, population: 0.2, tier: 'regional' },
  { code: 'BIS', name: 'Bismarck Municipal', city: 'Bismarck', country: 'US', lat: 46.77, lon: -100.75, population: 0.1, tier: 'regional' },
  { code: 'BTR', name: 'Baton Rouge Metro', city: 'Baton Rouge', country: 'US', lat: 30.53, lon: -91.15, population: 0.8, tier: 'regional' },
  { code: 'BTV', name: 'Burlington Intl', city: 'Burlington VT', country: 'US', lat: 44.47, lon: -73.15, population: 0.2, tier: 'regional' },
  { code: 'BUF', name: 'Buffalo Niagara Intl', city: 'Buffalo', country: 'US', lat: 42.94, lon: -78.73, population: 1.2, tier: 'regional' },
  { code: 'CAE', name: 'Columbia Metropolitan', city: 'Columbia SC', country: 'US', lat: 33.94, lon: -81.12, population: 0.8, tier: 'regional' },
  { code: 'CAK', name: 'Akron-Canton Regional', city: 'Akron', country: 'US', lat: 40.92, lon: -81.44, population: 0.7, tier: 'regional' },
  { code: 'CHA', name: 'Chattanooga Metropolitan', city: 'Chattanooga', country: 'US', lat: 35.04, lon: -85.2, population: 0.6, tier: 'regional' },
  { code: 'CHS', name: 'Charleston Intl', city: 'Charleston SC', country: 'US', lat: 32.9, lon: -80.04, population: 0.8, tier: 'regional' },
  { code: 'CID', name: 'Eastern Iowa Airport', city: 'Cedar Rapids', country: 'US', lat: 41.88, lon: -91.71, population: 0.3, tier: 'regional' },
  { code: 'COS', name: 'Colorado Springs Airport', city: 'Colorado Springs', country: 'US', lat: 38.81, lon: -104.7, population: 0.7, tier: 'regional' },
  { code: 'CPR', name: 'Casper/Natrona County Intl', city: 'Casper', country: 'US', lat: 42.91, lon: -106.46, population: 0.1, tier: 'regional' },
  { code: 'CRP', name: 'Corpus Christi Intl', city: 'Corpus Christi', country: 'US', lat: 27.77, lon: -97.5, population: 0.4, tier: 'regional' },
  { code: 'CVG', name: 'Cincinnati/Northern KY Intl', city: 'Cincinnati', country: 'US', lat: 39.05, lon: -84.67, population: 2.2, tier: 'regional' },
  { code: 'DAB', name: 'Daytona Beach Intl', city: 'Daytona Beach', country: 'US', lat: 29.18, lon: -81.06, population: 0.6, tier: 'regional' },
  { code: 'DAL', name: 'Dallas Love Field', city: 'Dallas', country: 'US', lat: 32.85, lon: -96.85, population: 7.7, tier: 'regional' },
  { code: 'DAY', name: 'Dayton Intl', city: 'Dayton', country: 'US', lat: 39.9, lon: -84.22, population: 0.8, tier: 'regional' },
  { code: 'DLH', name: 'Duluth Intl', city: 'Duluth', country: 'US', lat: 46.84, lon: -92.19, population: 0.1, tier: 'regional' },
  { code: 'EUG', name: 'Eugene Airport', city: 'Eugene', country: 'US', lat: 44.12, lon: -123.22, population: 0.4, tier: 'regional' },
  { code: 'EVV', name: 'Evansville Regional', city: 'Evansville', country: 'US', lat: 38.04, lon: -87.53, population: 0.3, tier: 'regional' },
  { code: 'FAI', name: 'Fairbanks Intl', city: 'Fairbanks', country: 'US', lat: 64.82, lon: -147.86, population: 0.1, tier: 'regional' },
  { code: 'FAR', name: 'Hector Intl', city: 'Fargo', country: 'US', lat: 46.92, lon: -96.82, population: 0.2, tier: 'regional' },
  { code: 'FAT', name: 'Fresno Yosemite Intl', city: 'Fresno', country: 'US', lat: 36.78, lon: -119.72, population: 1.0, tier: 'regional' },
  { code: 'FCA', name: 'Glacier Park Intl', city: 'Kalispell', country: 'US', lat: 48.31, lon: -114.26, population: 0.1, tier: 'regional' },
  { code: 'FNT', name: 'Bishop Intl', city: 'Flint', country: 'US', lat: 42.97, lon: -83.74, population: 0.4, tier: 'regional' },
  { code: 'FSD', name: 'Sioux Falls Regional', city: 'Sioux Falls', country: 'US', lat: 43.58, lon: -96.74, population: 0.3, tier: 'regional' },
  { code: 'FWA', name: 'Fort Wayne Intl', city: 'Fort Wayne', country: 'US', lat: 40.98, lon: -85.2, population: 0.4, tier: 'regional' },
  { code: 'GJT', name: 'Grand Junction Regional', city: 'Grand Junction', country: 'US', lat: 39.12, lon: -108.53, population: 0.2, tier: 'regional' },
  { code: 'GPT', name: 'Gulfport-Biloxi Intl', city: 'Gulfport', country: 'US', lat: 30.41, lon: -89.07, population: 0.4, tier: 'regional' },
  { code: 'GRB', name: 'Green Bay Austin Straubel', city: 'Green Bay', country: 'US', lat: 44.49, lon: -88.13, population: 0.3, tier: 'regional' },
  { code: 'GRR', name: 'Gerald R. Ford Intl', city: 'Grand Rapids', country: 'US', lat: 42.88, lon: -85.52, population: 1.1, tier: 'regional' },
  { code: 'GSO', name: 'Piedmont Triad Intl', city: 'Greensboro', country: 'US', lat: 36.1, lon: -79.94, population: 1.6, tier: 'regional' },
  { code: 'GTF', name: 'Great Falls Intl', city: 'Great Falls', country: 'US', lat: 47.48, lon: -111.37, population: 0.1, tier: 'regional' },
  { code: 'HPN', name: 'Westchester County', city: 'White Plains', country: 'US', lat: 41.07, lon: -73.71, population: 20.1, tier: 'regional' },
  { code: 'HRL', name: 'Valley Intl', city: 'Harlingen', country: 'US', lat: 26.23, lon: -97.65, population: 0.4, tier: 'regional' },
  { code: 'HSV', name: 'Huntsville Intl', city: 'Huntsville', country: 'US', lat: 34.64, lon: -86.78, population: 0.5, tier: 'regional' },
  { code: 'ICT', name: 'Wichita Eisenhower Natl', city: 'Wichita', country: 'US', lat: 37.65, lon: -97.43, population: 0.6, tier: 'regional' },
  { code: 'IDA', name: 'Idaho Falls Regional', city: 'Idaho Falls', country: 'US', lat: 43.51, lon: -112.07, population: 0.1, tier: 'regional' },
  { code: 'ILM', name: 'Wilmington Intl', city: 'Wilmington NC', country: 'US', lat: 34.27, lon: -77.9, population: 0.4, tier: 'regional' },
  { code: 'JAC', name: 'Jackson Hole Airport', city: 'Jackson Hole', country: 'US', lat: 43.61, lon: -110.74, population: 0.03, tier: 'regional' },
  { code: 'JAN', name: 'Jackson-Medgar Wiley Evers', city: 'Jackson MS', country: 'US', lat: 32.31, lon: -90.08, population: 0.6, tier: 'regional' },
  { code: 'JNU', name: 'Juneau Intl', city: 'Juneau', country: 'US', lat: 58.36, lon: -134.58, population: 0.03, tier: 'regional' },
  { code: 'LAW', name: 'Lawton-Fort Sill Regional', city: 'Lawton', country: 'US', lat: 34.57, lon: -98.42, population: 0.1, tier: 'regional' },
  { code: 'LBB', name: 'Lubbock Preston Smith Intl', city: 'Lubbock', country: 'US', lat: 33.66, lon: -101.82, population: 0.3, tier: 'regional' },
  { code: 'LEX', name: 'Blue Grass Airport', city: 'Lexington', country: 'US', lat: 38.04, lon: -84.61, population: 0.5, tier: 'regional' },
  { code: 'LFT', name: 'Lafayette Regional', city: 'Lafayette LA', country: 'US', lat: 30.21, lon: -91.99, population: 0.3, tier: 'regional' },
  { code: 'LGB', name: 'Long Beach Airport', city: 'Long Beach', country: 'US', lat: 33.82, lon: -118.15, population: 13.2, tier: 'regional' },
  { code: 'LIT', name: 'Clinton National Airport', city: 'Little Rock', country: 'US', lat: 34.73, lon: -92.22, population: 0.7, tier: 'regional' },
  { code: 'LNK', name: 'Lincoln Airport', city: 'Lincoln NE', country: 'US', lat: 40.85, lon: -96.76, population: 0.3, tier: 'regional' },
  { code: 'MAF', name: 'Midland Intl Air and Space', city: 'Midland TX', country: 'US', lat: 31.94, lon: -102.2, population: 0.3, tier: 'regional' },
  { code: 'MDT', name: 'Harrisburg Intl', city: 'Harrisburg', country: 'US', lat: 40.19, lon: -76.76, population: 0.6, tier: 'regional' },
  { code: 'MLB', name: 'Melbourne Orlando Intl', city: 'Melbourne FL', country: 'US', lat: 28.1, lon: -80.64, population: 0.8, tier: 'regional' },
  { code: 'MLI', name: 'Quad City Intl', city: 'Moline', country: 'US', lat: 41.45, lon: -90.51, population: 0.4, tier: 'regional' },
  { code: 'MOB', name: 'Mobile Regional', city: 'Mobile', country: 'US', lat: 30.69, lon: -88.24, population: 0.6, tier: 'regional' },
  { code: 'MOT', name: 'Minot Intl', city: 'Minot', country: 'US', lat: 48.26, lon: -101.28, population: 0.07, tier: 'regional' },
  { code: 'MRY', name: 'Monterey Regional', city: 'Monterey', country: 'US', lat: 36.59, lon: -121.84, population: 0.4, tier: 'regional' },
  { code: 'MSN', name: 'Dane County Regional', city: 'Madison WI', country: 'US', lat: 43.14, lon: -89.34, population: 0.7, tier: 'regional' },
  { code: 'MTJ', name: 'Montrose Regional', city: 'Montrose CO', country: 'US', lat: 38.51, lon: -107.9, population: 0.05, tier: 'regional' },
  { code: 'MYR', name: 'Myrtle Beach Intl', city: 'Myrtle Beach', country: 'US', lat: 33.68, lon: -78.93, population: 0.5, tier: 'regional' },
  { code: 'OAJ', name: 'Albert J. Ellis Airport', city: 'Jacksonville NC', country: 'US', lat: 34.83, lon: -77.61, population: 0.2, tier: 'regional' },
  { code: 'PFN', name: 'Northwest Florida Beaches Intl', city: 'Panama City FL', country: 'US', lat: 30.21, lon: -85.68, population: 0.2, tier: 'regional' },
  { code: 'PIE', name: 'St. Pete-Clearwater Intl', city: 'St. Petersburg', country: 'US', lat: 27.91, lon: -82.69, population: 3.2, tier: 'regional' },
  { code: 'PNS', name: 'Pensacola Intl', city: 'Pensacola', country: 'US', lat: 30.47, lon: -87.19, population: 0.5, tier: 'regional' },
  { code: 'PWM', name: 'Portland Intl Jetport', city: 'Portland ME', country: 'US', lat: 43.65, lon: -70.31, population: 0.5, tier: 'regional' },
  { code: 'RAP', name: 'Rapid City Regional', city: 'Rapid City', country: 'US', lat: 44.05, lon: -103.06, population: 0.1, tier: 'regional' },
  { code: 'ROA', name: 'Roanoke-Blacksburg Regional', city: 'Roanoke', country: 'US', lat: 37.33, lon: -79.97, population: 0.3, tier: 'regional' },
  { code: 'ROC', name: 'Greater Rochester Intl', city: 'Rochester NY', country: 'US', lat: 43.12, lon: -77.67, population: 1.1, tier: 'regional' },
  { code: 'RST', name: 'Rochester Intl', city: 'Rochester MN', country: 'US', lat: 43.91, lon: -92.5, population: 0.2, tier: 'regional' },
  { code: 'SAV', name: 'Savannah/Hilton Head Intl', city: 'Savannah', country: 'US', lat: 32.13, lon: -81.2, population: 0.4, tier: 'regional' },
  { code: 'SBA', name: 'Santa Barbara Municipal', city: 'Santa Barbara', country: 'US', lat: 34.43, lon: -119.84, population: 0.4, tier: 'regional' },
  { code: 'SBN', name: 'South Bend Intl', city: 'South Bend', country: 'US', lat: 41.71, lon: -86.32, population: 0.3, tier: 'regional' },
  { code: 'SHV', name: 'Shreveport Regional', city: 'Shreveport', country: 'US', lat: 32.45, lon: -93.83, population: 0.4, tier: 'regional' },
  { code: 'SPI', name: 'Abraham Lincoln Capital', city: 'Springfield IL', country: 'US', lat: 39.84, lon: -89.68, population: 0.2, tier: 'regional' },
  { code: 'SRQ', name: 'Sarasota-Bradenton Intl', city: 'Sarasota', country: 'US', lat: 27.4, lon: -82.55, population: 0.8, tier: 'regional' },
  { code: 'SUX', name: 'Sioux Gateway Airport', city: 'Sioux City', country: 'US', lat: 42.4, lon: -96.38, population: 0.1, tier: 'regional' },
  { code: 'SWF', name: 'Stewart Intl', city: 'Newburgh NY', country: 'US', lat: 41.5, lon: -74.1, population: 20.1, tier: 'regional' },
  { code: 'SYR', name: 'Syracuse Hancock Intl', city: 'Syracuse', country: 'US', lat: 43.11, lon: -76.11, population: 0.7, tier: 'regional' },
  { code: 'TLH', name: 'Tallahassee Intl', city: 'Tallahassee', country: 'US', lat: 30.4, lon: -84.35, population: 0.4, tier: 'regional' },
  { code: 'TOL', name: 'Toledo Express Airport', city: 'Toledo', country: 'US', lat: 41.59, lon: -83.81, population: 0.7, tier: 'regional' },
  { code: 'TRI', name: 'Tri-Cities Regional', city: 'Kingsport TN', country: 'US', lat: 36.48, lon: -82.41, population: 0.5, tier: 'regional' },
  { code: 'TYS', name: 'McGhee Tyson Airport', city: 'Knoxville', country: 'US', lat: 35.81, lon: -83.99, population: 0.9, tier: 'regional' },
  { code: 'XNA', name: 'Northwest Arkansas Natl', city: 'Fayetteville AR', country: 'US', lat: 36.28, lon: -94.31, population: 0.6, tier: 'regional' },
  { code: 'YKM', name: 'Yakima Air Terminal', city: 'Yakima', country: 'US', lat: 46.57, lon: -120.54, population: 0.1, tier: 'regional' },
  { code: 'ATW', name: 'Appleton Intl', city: 'Appleton WI', country: 'US', lat: 44.26, lon: -88.52, population: 0.3, tier: 'regional' },
  { code: 'EAU', name: 'Chippewa Valley Regional', city: 'Eau Claire WI', country: 'US', lat: 44.87, lon: -91.48, population: 0.2, tier: 'regional' },
  { code: 'CWA', name: 'Central Wisconsin Airport', city: 'Wausau WI', country: 'US', lat: 44.78, lon: -89.67, population: 0.1, tier: 'regional' },
  { code: 'DBQ', name: 'Dubuque Regional Airport', city: 'Dubuque IA', country: 'US', lat: 42.4, lon: -90.71, population: 0.1, tier: 'regional' },
  { code: 'ALO', name: 'Waterloo Regional Airport', city: 'Waterloo IA', country: 'US', lat: 42.56, lon: -92.4, population: 0.1, tier: 'regional' },
  { code: 'MCW', name: 'Mason City Municipal', city: 'Mason City IA', country: 'US', lat: 43.16, lon: -93.33, population: 0.05, tier: 'regional' },
  { code: 'GFK', name: 'Grand Forks Intl', city: 'Grand Forks ND', country: 'US', lat: 47.95, lon: -97.18, population: 0.1, tier: 'regional' },
  { code: 'MKG', name: 'Muskegon County Airport', city: 'Muskegon MI', country: 'US', lat: 43.17, lon: -86.24, population: 0.2, tier: 'regional' },
  { code: 'TVC', name: 'Cherry Capital Airport', city: 'Traverse City MI', country: 'US', lat: 44.74, lon: -85.58, population: 0.2, tier: 'regional' },
  { code: 'CKB', name: 'North Central WV Airport', city: 'Clarksburg WV', country: 'US', lat: 39.3, lon: -80.23, population: 0.1, tier: 'regional' },
  { code: 'PKB', name: 'Mid-Ohio Valley Regional', city: 'Parkersburg WV', country: 'US', lat: 39.35, lon: -81.44, population: 0.1, tier: 'regional' },
  { code: 'HTS', name: 'Tri-State Airport', city: 'Huntington WV', country: 'US', lat: 38.37, lon: -82.56, population: 0.1, tier: 'regional' },
  { code: 'LYH', name: 'Lynchburg Regional', city: 'Lynchburg VA', country: 'US', lat: 37.33, lon: -79.2, population: 0.1, tier: 'regional' },
  { code: 'CHO', name: 'Charlottesville-Albemarle', city: 'Charlottesville', country: 'US', lat: 38.14, lon: -78.45, population: 0.5, tier: 'regional' },
  { code: 'SBY', name: 'Salisbury-Ocean City Regional', city: 'Salisbury MD', country: 'US', lat: 38.34, lon: -75.51, population: 0.1, tier: 'regional' },
  { code: 'ACY', name: 'Atlantic City Intl', city: 'Atlantic City', country: 'US', lat: 39.46, lon: -74.58, population: 0.3, tier: 'regional' },
  { code: 'ELM', name: 'Elmira/Corning Regional', city: 'Elmira NY', country: 'US', lat: 42.16, lon: -76.89, population: 0.2, tier: 'regional' },
  { code: 'ITH', name: 'Ithaca Tompkins Regional', city: 'Ithaca NY', country: 'US', lat: 42.49, lon: -76.46, population: 0.05, tier: 'regional' },
  { code: 'GRI', name: 'Central Nebraska Regional', city: 'Grand Island NE', country: 'US', lat: 40.97, lon: -98.31, population: 0.1, tier: 'regional' },
  { code: 'GCK', name: 'Garden City Regional', city: 'Garden City KS', country: 'US', lat: 37.93, lon: -100.72, population: 0.05, tier: 'regional' },
  { code: 'LSE', name: 'La Crosse Regional Airport', city: 'La Crosse WI', country: 'US', lat: 43.88, lon: -91.26, population: 0.1, tier: 'regional' },
  { code: 'GTR', name: 'Golden Triangle Regional', city: 'Columbus MS', country: 'US', lat: 33.45, lon: -88.59, population: 0.1, tier: 'regional' },
  { code: 'TUP', name: 'Tupelo Regional Airport', city: 'Tupelo', country: 'US', lat: 34.27, lon: -88.77, population: 0.1, tier: 'regional' },
  { code: 'SHD', name: 'Shenandoah Valley Regional', city: 'Weyers Cave VA', country: 'US', lat: 38.26, lon: -78.9, population: 0.1, tier: 'regional' },
  { code: 'IPT', name: 'Williamsport Regional', city: 'Williamsport PA', country: 'US', lat: 41.24, lon: -76.92, population: 0.1, tier: 'regional' },
  { code: 'HGR', name: 'Hagerstown Regional', city: 'Hagerstown MD', country: 'US', lat: 39.71, lon: -77.73, population: 0.1, tier: 'regional' },
  { code: 'YFC', name: 'Fredericton Intl', city: 'Fredericton', country: 'CA', lat: 45.87, lon: -66.54, population: 0.1, tier: 'regional' },
  { code: 'YHM', name: 'John C. Munro Hamilton Intl', city: 'Hamilton ON', country: 'CA', lat: 43.17, lon: -79.93, population: 0.8, tier: 'regional' },
  { code: 'YKA', name: 'Kamloops Airport', city: 'Kamloops', country: 'CA', lat: 50.7, lon: -120.44, population: 0.1, tier: 'regional' },
  { code: 'YLW', name: 'Kelowna Intl', city: 'Kelowna', country: 'CA', lat: 49.96, lon: -119.38, population: 0.2, tier: 'regional' },
  { code: 'YMM', name: 'Fort McMurray Intl', city: 'Fort McMurray', country: 'CA', lat: 56.65, lon: -111.22, population: 0.07, tier: 'regional' },
  { code: 'YQR', name: 'Regina Intl', city: 'Regina', country: 'CA', lat: 50.43, lon: -104.67, population: 0.2, tier: 'regional' },
  { code: 'YQT', name: 'Thunder Bay Intl', city: 'Thunder Bay', country: 'CA', lat: 48.37, lon: -89.32, population: 0.1, tier: 'regional' },
  { code: 'YSJ', name: 'Saint John Airport', city: 'Saint John NB', country: 'CA', lat: 45.32, lon: -65.89, population: 0.1, tier: 'regional' },
  { code: 'YXE', name: 'John G. Diefenbaker Intl', city: 'Saskatoon', country: 'CA', lat: 52.17, lon: -106.7, population: 0.3, tier: 'regional' },
  { code: 'YXS', name: 'Prince George Airport', city: 'Prince George', country: 'CA', lat: 53.89, lon: -122.68, population: 0.08, tier: 'regional' },
  { code: 'YXU', name: 'London Intl', city: 'London ON', country: 'CA', lat: 43.03, lon: -81.15, population: 0.5, tier: 'regional' },
  { code: 'YYB', name: 'North Bay Jack Garland', city: 'North Bay', country: 'CA', lat: 46.36, lon: -79.42, population: 0.07, tier: 'regional' },
  { code: 'YYJ', name: 'Victoria Intl', city: 'Victoria', country: 'CA', lat: 48.65, lon: -123.43, population: 0.4, tier: 'regional' },
  { code: 'YZF', name: 'Yellowknife Airport', city: 'Yellowknife', country: 'CA', lat: 62.46, lon: -114.44, population: 0.02, tier: 'regional' },
  { code: 'YXY', name: 'Erik Nielsen Whitehorse Intl', city: 'Whitehorse', country: 'CA', lat: 60.71, lon: -135.07, population: 0.04, tier: 'regional' },
  { code: 'AQP', name: 'Rodriguez Ballon Intl', city: 'Arequipa', country: 'PE', lat: -16.34, lon: -71.58, population: 1.1, tier: 'regional' },
  { code: 'BGA', name: 'Palonegro Intl', city: 'Bucaramanga', country: 'CO', lat: 7.13, lon: -73.18, population: 1.3, tier: 'regional' },
  { code: 'BZE', name: 'Philip S.W. Goldson Intl', city: 'Belize City', country: 'BZ', lat: 17.54, lon: -88.31, population: 0.09, tier: 'regional' },
  { code: 'CIX', name: 'Capitan FAP Quiones Intl', city: 'Chiclayo', country: 'PE', lat: -6.79, lon: -79.83, population: 0.9, tier: 'regional' },
  { code: 'CJC', name: 'El Loa Airport', city: 'Calama', country: 'CL', lat: -22.5, lon: -68.9, population: 0.2, tier: 'regional' },
  { code: 'COR', name: 'Ingeniero A. Taravella Intl', city: 'Cordoba', country: 'AR', lat: -31.32, lon: -64.21, population: 1.5, tier: 'regional' },
  { code: 'CUC', name: 'Camilo Daza Intl', city: 'Cucuta', country: 'CO', lat: 7.93, lon: -72.51, population: 0.7, tier: 'regional' },
  { code: 'CUZ', name: 'Alejandro Velasco Astete Intl', city: 'Cusco', country: 'PE', lat: -13.54, lon: -71.94, population: 0.4, tier: 'regional' },
  { code: 'CZM', name: 'Cozumel Intl', city: 'Cozumel', country: 'MX', lat: 20.52, lon: -86.93, population: 0.08, tier: 'regional' },
  { code: 'FLN', name: 'Hercilio Luz Intl', city: 'Florianopolis', country: 'BR', lat: -27.67, lon: -48.55, population: 1.1, tier: 'regional' },
  { code: 'GEO', name: 'Cheddi Jagan Intl', city: 'Georgetown', country: 'GY', lat: 6.5, lon: -58.25, population: 0.3, tier: 'regional' },
  { code: 'GYN', name: 'Santa Genoveva Airport', city: 'Goiania', country: 'BR', lat: -16.63, lon: -49.22, population: 2.5, tier: 'regional' },
  { code: 'IQQ', name: 'Diego Aracena Intl', city: 'Iquique', country: 'CL', lat: -20.53, lon: -70.18, population: 0.3, tier: 'regional' },
  { code: 'IQT', name: 'Coronel FAP Secada Intl', city: 'Iquitos', country: 'PE', lat: -3.78, lon: -73.31, population: 0.5, tier: 'regional' },
  { code: 'MGF', name: 'Regional de Maringa', city: 'Maringa', country: 'BR', lat: -23.48, lon: -52.02, population: 0.7, tier: 'regional' },
  { code: 'NQN', name: 'Presidente Peron Intl', city: 'Neuquen', country: 'AR', lat: -38.95, lon: -68.16, population: 0.3, tier: 'regional' },
  { code: 'PMC', name: 'El Tepual Intl', city: 'Puerto Montt', country: 'CL', lat: -41.44, lon: -73.09, population: 0.3, tier: 'regional' },
  { code: 'POP', name: 'Gregorio Luperon Intl', city: 'Puerto Plata', country: 'DO', lat: 19.76, lon: -70.57, population: 0.3, tier: 'regional' },
  { code: 'PUJ', name: 'Punta Cana Intl', city: 'Punta Cana', country: 'DO', lat: 18.57, lon: -68.36, population: 0.1, tier: 'regional' },
  { code: 'PVH', name: 'Governador J. Canedo Intl', city: 'Porto Velho', country: 'BR', lat: -8.71, lon: -63.9, population: 0.5, tier: 'regional' },
  { code: 'SLP', name: 'Ponciano Arriaga Intl', city: 'San Luis Potosi', country: 'MX', lat: 22.25, lon: -100.93, population: 1.2, tier: 'regional' },
  { code: 'STI', name: 'Cibao Intl', city: 'Santiago DR', country: 'DO', lat: 19.41, lon: -70.6, population: 1.0, tier: 'regional' },
  { code: 'TGU', name: 'Toncontin Intl', city: 'Tegucigalpa', country: 'HN', lat: 14.06, lon: -87.22, population: 1.5, tier: 'regional' },
  { code: 'TRC', name: 'Francisco Sarabia Intl', city: 'Torreon', country: 'MX', lat: 25.57, lon: -103.41, population: 1.5, tier: 'regional' },
  { code: 'VCP', name: 'Campinas Viracopos Intl', city: 'Campinas', country: 'BR', lat: -23.01, lon: -47.13, population: 3.2, tier: 'regional' },
  { code: 'CNF', name: 'Belo Horizonte Confins Intl', city: 'Belo Horizonte', country: 'BR', lat: -19.63, lon: -43.97, population: 6.0, tier: 'major' },
  { code: 'MCZ', name: 'Zumbi dos Palmares Intl', city: 'Maceio', country: 'BR', lat: -9.51, lon: -35.79, population: 1.0, tier: 'regional' },
  { code: 'NAT', name: 'Governador Aloizio Intl', city: 'Natal', country: 'BR', lat: -5.77, lon: -35.38, population: 1.7, tier: 'regional' },
  { code: 'JPA', name: 'Presidente Castro Pinto Intl', city: 'Joao Pessoa', country: 'BR', lat: -7.15, lon: -34.95, population: 1.0, tier: 'regional' },
  { code: 'AJU', name: 'Santa Maria Airport', city: 'Aracaju', country: 'BR', lat: -10.98, lon: -37.07, population: 0.6, tier: 'regional' },
  { code: 'CGB', name: 'Marechal Rondon Intl', city: 'Cuiaba', country: 'BR', lat: -15.65, lon: -56.12, population: 0.7, tier: 'regional' },
  { code: 'IGR', name: 'Cataratas del Iguazu Intl', city: 'Puerto Iguazu', country: 'AR', lat: -25.74, lon: -54.47, population: 0.06, tier: 'regional' },
  { code: 'PMW', name: 'Brigadeiro Lysias Rodrigues', city: 'Palmas', country: 'BR', lat: -10.29, lon: -48.36, population: 0.3, tier: 'regional' },
  { code: 'THE', name: 'Senador Petronion Portella', city: 'Teresina', country: 'BR', lat: -5.06, lon: -42.82, population: 0.9, tier: 'regional' },
  { code: 'MAB', name: 'Joao Correa da Rocha', city: 'Maraba', country: 'BR', lat: -5.37, lon: -49.14, population: 0.2, tier: 'regional' },
  { code: 'UDI', name: 'Ten. Cel. Av. C. Morais Intl', city: 'Uberlandia', country: 'BR', lat: -18.88, lon: -48.23, population: 0.7, tier: 'regional' },
  { code: 'JOI', name: 'Lauro Carneiro de Loyola', city: 'Joinville', country: 'BR', lat: -26.22, lon: -48.8, population: 0.6, tier: 'regional' },
  { code: 'LDB', name: 'Londrina Airport', city: 'Londrina', country: 'BR', lat: -23.33, lon: -51.13, population: 0.6, tier: 'regional' },
  { code: 'XAP', name: 'Serafin Enoss Bertaso', city: 'Chapeco', country: 'BR', lat: -27.13, lon: -52.66, population: 0.2, tier: 'regional' },
  { code: 'MZT', name: 'General Rafael Buelna Intl', city: 'Mazatlan', country: 'MX', lat: 23.16, lon: -106.27, population: 0.5, tier: 'regional' },
  { code: 'ZLO', name: 'Playa de Oro Intl', city: 'Manzanillo MX', country: 'MX', lat: 19.14, lon: -104.56, population: 0.2, tier: 'regional' },
  { code: 'HUX', name: 'Bahias de Huatulco Intl', city: 'Huatulco', country: 'MX', lat: 15.78, lon: -96.26, population: 0.05, tier: 'regional' },
  { code: 'VSA', name: 'Carlos Rovirosa Perez Intl', city: 'Villahermosa', country: 'MX', lat: 17.99, lon: -92.82, population: 0.7, tier: 'regional' },
  { code: 'CME', name: 'Ciudad del Carmen Intl', city: 'Ciudad del Carmen', country: 'MX', lat: 18.65, lon: -91.8, population: 0.2, tier: 'regional' },
  { code: 'MXL', name: 'Gen. Rodolfo Sanchez Intl', city: 'Mexicali', country: 'MX', lat: 32.63, lon: -115.24, population: 1.1, tier: 'regional' },
  { code: 'HMO', name: 'Gen. Ignacio P. Garcia Intl', city: 'Hermosillo', country: 'MX', lat: 29.1, lon: -111.05, population: 1.0, tier: 'regional' },
  { code: 'CUL', name: 'Bachigualato Fed. Intl', city: 'Culiacan', country: 'MX', lat: 24.76, lon: -107.47, population: 1.0, tier: 'regional' },
  { code: 'DGO', name: 'Gen. Guadalupe Victoria Intl', city: 'Durango', country: 'MX', lat: 24.12, lon: -104.53, population: 0.7, tier: 'regional' },
  { code: 'AGU', name: 'Lic. Jesus Teran Peredo Intl', city: 'Aguascalientes', country: 'MX', lat: 21.71, lon: -102.32, population: 1.1, tier: 'regional' },
  { code: 'MLM', name: 'Gen. Francisco J. Mujica Intl', city: 'Morelia', country: 'MX', lat: 19.85, lon: -101.02, population: 0.9, tier: 'regional' },
  { code: 'QRO', name: 'Queretaro Intl', city: 'Queretaro', country: 'MX', lat: 20.62, lon: -100.19, population: 1.1, tier: 'regional' },
  { code: 'TAP', name: 'Tapachula Intl', city: 'Tapachula', country: 'MX', lat: 14.79, lon: -92.37, population: 0.3, tier: 'regional' },
  { code: 'VER', name: 'General Heriberto Jara Intl', city: 'Veracruz', country: 'MX', lat: 19.14, lon: -96.19, population: 0.8, tier: 'regional' },
  { code: 'OAX', name: 'Xoxocotlan Intl', city: 'Oaxaca', country: 'MX', lat: 16.99, lon: -96.73, population: 0.3, tier: 'regional' },
  { code: 'ZCL', name: 'Gen. Leobardo C. Ruiz Intl', city: 'Zacatecas', country: 'MX', lat: 22.9, lon: -102.69, population: 0.3, tier: 'regional' },
  { code: 'CLQ', name: 'Lic. Miguel de la Madrid', city: 'Colima', country: 'MX', lat: 19.28, lon: -103.58, population: 0.4, tier: 'regional' },
  { code: 'RTB', name: 'Roatan Island Airport', city: 'Roatan', country: 'HN', lat: 16.32, lon: -86.52, population: 0.05, tier: 'regional' },
  { code: 'LIR', name: 'Daniel Oduber Quiros Intl', city: 'Liberia CR', country: 'CR', lat: 10.59, lon: -85.54, population: 0.09, tier: 'regional' },
  { code: 'AAR', name: 'Aarhus Airport', city: 'Aarhus', country: 'DK', lat: 56.3, lon: 10.62, population: 0.3, tier: 'regional' },
  { code: 'ABZ', name: 'Aberdeen Intl', city: 'Aberdeen', country: 'GB', lat: 57.2, lon: -2.2, population: 0.3, tier: 'regional' },
  { code: 'ACE', name: 'Lanzarote Airport', city: 'Lanzarote', country: 'ES', lat: 28.95, lon: -13.61, population: 0.15, tier: 'regional' },
  { code: 'AES', name: 'Alesund Airport', city: 'Alesund', country: 'NO', lat: 62.56, lon: 6.12, population: 0.1, tier: 'regional' },
  { code: 'AHO', name: 'Alghero-Fertilia Airport', city: 'Alghero', country: 'IT', lat: 40.63, lon: 8.29, population: 0.04, tier: 'regional' },
  { code: 'AJA', name: 'Ajaccio Napoleon Bonaparte', city: 'Ajaccio', country: 'FR', lat: 41.92, lon: 8.8, population: 0.07, tier: 'regional' },
  { code: 'ALC', name: 'Alicante-Elche Airport', city: 'Alicante', country: 'ES', lat: 38.28, lon: -0.56, population: 0.8, tier: 'regional' },
  { code: 'AOI', name: 'Ancona Falconara Airport', city: 'Ancona', country: 'IT', lat: 43.62, lon: 13.36, population: 0.5, tier: 'regional' },
  { code: 'BDS', name: 'Brindisi Airport', city: 'Brindisi', country: 'IT', lat: 40.66, lon: 17.95, population: 0.2, tier: 'regional' },
  { code: 'BIA', name: 'Bastia-Poretta Airport', city: 'Bastia', country: 'FR', lat: 42.55, lon: 9.49, population: 0.07, tier: 'regional' },
  { code: 'BJV', name: 'Milas-Bodrum Airport', city: 'Bodrum', country: 'TR', lat: 37.25, lon: 27.66, population: 0.1, tier: 'regional' },
  { code: 'BLL', name: 'Billund Airport', city: 'Billund', country: 'DK', lat: 55.74, lon: 9.15, population: 0.05, tier: 'regional' },
  { code: 'BRQ', name: 'Brno-Turany Airport', city: 'Brno', country: 'CZ', lat: 49.15, lon: 16.69, population: 0.4, tier: 'regional' },
  { code: 'CAG', name: 'Cagliari Elmas Airport', city: 'Cagliari', country: 'IT', lat: 39.25, lon: 9.06, population: 0.4, tier: 'regional' },
  { code: 'CFU', name: 'Corfu Intl', city: 'Corfu', country: 'GR', lat: 39.6, lon: 19.91, population: 0.1, tier: 'regional' },
  { code: 'CIA', name: 'Rome Ciampino Airport', city: 'Rome', country: 'IT', lat: 41.8, lon: 12.59, population: 4.3, tier: 'regional' },
  { code: 'CRL', name: 'Brussels South Charleroi', city: 'Charleroi', country: 'BE', lat: 50.46, lon: 4.45, population: 0.5, tier: 'regional' },
  { code: 'DRS', name: 'Dresden Airport', city: 'Dresden', country: 'DE', lat: 51.13, lon: 13.77, population: 0.6, tier: 'regional' },
  { code: 'EIN', name: 'Eindhoven Airport', city: 'Eindhoven', country: 'NL', lat: 51.45, lon: 5.37, population: 0.4, tier: 'regional' },
  { code: 'EMA', name: 'East Midlands Airport', city: 'Nottingham', country: 'GB', lat: 52.83, lon: -1.33, population: 1.0, tier: 'regional' },
  { code: 'FLR', name: 'Florence Airport', city: 'Florence', country: 'IT', lat: 43.81, lon: 11.2, population: 1.0, tier: 'regional' },
  { code: 'FUE', name: 'Fuerteventura Airport', city: 'Fuerteventura', country: 'ES', lat: 28.45, lon: -13.86, population: 0.11, tier: 'regional' },
  { code: 'GDN', name: 'Gdansk Lech Walesa Airport', city: 'Gdansk', country: 'PL', lat: 54.38, lon: 18.47, population: 0.8, tier: 'regional' },
  { code: 'GRO', name: 'Girona-Costa Brava Airport', city: 'Girona', country: 'ES', lat: 41.9, lon: 2.76, population: 0.1, tier: 'regional' },
  { code: 'GRZ', name: 'Graz Airport', city: 'Graz', country: 'AT', lat: 46.99, lon: 15.44, population: 0.3, tier: 'regional' },
  { code: 'GVA', name: 'Geneva Airport', city: 'Geneva', country: 'CH', lat: 46.24, lon: 6.11, population: 0.6, tier: 'major' },
  { code: 'INN', name: 'Innsbruck Airport', city: 'Innsbruck', country: 'AT', lat: 47.26, lon: 11.34, population: 0.2, tier: 'regional' },
  { code: 'JER', name: 'Jersey Airport', city: 'Saint Helier', country: 'JE', lat: 49.21, lon: -2.2, population: 0.1, tier: 'regional' },
  { code: 'KGS', name: 'Kos Island Intl', city: 'Kos', country: 'GR', lat: 36.79, lon: 27.09, population: 0.04, tier: 'regional' },
  { code: 'KRK', name: 'Krakow John Paul II Intl', city: 'Krakow', country: 'PL', lat: 50.08, lon: 19.78, population: 1.5, tier: 'regional' },
  { code: 'KRS', name: 'Kristiansand Airport', city: 'Kristiansand', country: 'NO', lat: 58.2, lon: 8.09, population: 0.1, tier: 'regional' },
  { code: 'KTW', name: 'Katowice Airport', city: 'Katowice', country: 'PL', lat: 50.47, lon: 19.08, population: 2.7, tier: 'regional' },
  { code: 'LCA', name: 'Larnaca Intl', city: 'Larnaca', country: 'CY', lat: 34.88, lon: 33.63, population: 0.4, tier: 'regional' },
  { code: 'LEJ', name: 'Leipzig/Halle Airport', city: 'Leipzig', country: 'DE', lat: 51.42, lon: 12.24, population: 0.6, tier: 'regional' },
  { code: 'LNZ', name: 'Linz Airport', city: 'Linz', country: 'AT', lat: 48.23, lon: 14.19, population: 0.2, tier: 'regional' },
  { code: 'LTN', name: 'London Luton Airport', city: 'London', country: 'GB', lat: 51.88, lon: -0.37, population: 9.3, tier: 'regional' },
  { code: 'LUX', name: 'Luxembourg Airport', city: 'Luxembourg', country: 'LU', lat: 49.63, lon: 6.21, population: 0.6, tier: 'regional' },
  { code: 'MAH', name: 'Menorca Airport', city: 'Mahon', country: 'ES', lat: 39.86, lon: 4.22, population: 0.09, tier: 'regional' },
  { code: 'MLA', name: 'Malta Intl', city: 'Valletta', country: 'MT', lat: 35.86, lon: 14.48, population: 0.5, tier: 'regional' },
  { code: 'MMX', name: 'Malmo Airport', city: 'Malmo', country: 'SE', lat: 55.54, lon: 13.37, population: 0.7, tier: 'regional' },
  { code: 'NYO', name: 'Stockholm Skavsta Airport', city: 'Stockholm', country: 'SE', lat: 58.79, lon: 16.91, population: 2.4, tier: 'regional' },
  { code: 'OLB', name: 'Olbia Costa Smeralda', city: 'Olbia', country: 'IT', lat: 40.9, lon: 9.52, population: 0.06, tier: 'regional' },
  { code: 'ORK', name: 'Cork Airport', city: 'Cork', country: 'IE', lat: 51.84, lon: -8.49, population: 0.3, tier: 'regional' },
  { code: 'SNN', name: 'Shannon Airport', city: 'Shannon', country: 'IE', lat: 52.7, lon: -8.92, population: 0.3, tier: 'regional' },
  { code: 'NOC', name: 'Ireland West Airport Knock', city: 'Knock', country: 'IE', lat: 53.91, lon: -8.82, population: 0.1, tier: 'regional' },
  { code: 'PFO', name: 'Paphos Intl', city: 'Paphos', country: 'CY', lat: 34.72, lon: 32.49, population: 0.4, tier: 'regional' },
  { code: 'POZ', name: 'Poznan-Lawica Airport', city: 'Poznan', country: 'PL', lat: 52.42, lon: 16.83, population: 0.7, tier: 'regional' },
  { code: 'PSR', name: 'Pescara Airport', city: 'Pescara', country: 'IT', lat: 42.43, lon: 14.18, population: 0.3, tier: 'regional' },
  { code: 'PUY', name: 'Pula Airport', city: 'Pula', country: 'HR', lat: 44.89, lon: 13.92, population: 0.06, tier: 'regional' },
  { code: 'RJK', name: 'Rijeka Airport', city: 'Rijeka', country: 'HR', lat: 45.22, lon: 14.57, population: 0.2, tier: 'regional' },
  { code: 'RTM', name: 'Rotterdam The Hague Airport', city: 'Rotterdam', country: 'NL', lat: 51.96, lon: 4.44, population: 1.0, tier: 'regional' },
  { code: 'RZE', name: 'Rzeszow-Jasionka Airport', city: 'Rzeszow', country: 'PL', lat: 50.11, lon: 22.02, population: 0.2, tier: 'regional' },
  { code: 'SDR', name: 'Santander Airport', city: 'Santander', country: 'ES', lat: 43.43, lon: -3.82, population: 0.2, tier: 'regional' },
  { code: 'SZG', name: 'Salzburg Airport', city: 'Salzburg', country: 'AT', lat: 47.8, lon: 13.0, population: 0.2, tier: 'regional' },
  { code: 'SZZ', name: 'Szczecin-Goleniow Airport', city: 'Szczecin', country: 'PL', lat: 53.58, lon: 14.9, population: 0.4, tier: 'regional' },
  { code: 'TGD', name: 'Podgorica Airport', city: 'Podgorica', country: 'ME', lat: 42.36, lon: 19.25, population: 0.3, tier: 'regional' },
  { code: 'TMP', name: 'Tampere-Pirkkala Airport', city: 'Tampere', country: 'FI', lat: 61.41, lon: 23.6, population: 0.4, tier: 'regional' },
  { code: 'TRS', name: 'Trieste Airport', city: 'Trieste', country: 'IT', lat: 45.83, lon: 13.47, population: 0.3, tier: 'regional' },
  { code: 'TSF', name: 'Venice Treviso Airport', city: 'Treviso', country: 'IT', lat: 45.65, lon: 12.19, population: 4.3, tier: 'regional' },
  { code: 'UME', name: 'Umea Airport', city: 'Umea', country: 'SE', lat: 63.79, lon: 20.28, population: 0.1, tier: 'regional' },
  { code: 'VGO', name: 'Vigo Airport', city: 'Vigo', country: 'ES', lat: 42.23, lon: -8.63, population: 0.3, tier: 'regional' },
  { code: 'VRN', name: 'Verona Villafranca Airport', city: 'Verona', country: 'IT', lat: 45.4, lon: 10.89, population: 0.5, tier: 'regional' },
  { code: 'WRO', name: 'Wroclaw Copernicus Airport', city: 'Wroclaw', country: 'PL', lat: 51.1, lon: 16.89, population: 0.9, tier: 'regional' },
  { code: 'KZN', name: 'Kazan Intl', city: 'Kazan', country: 'RU', lat: 55.61, lon: 49.28, population: 1.2, tier: 'regional' },
  { code: 'IKT', name: 'Irkutsk Intl', city: 'Irkutsk', country: 'RU', lat: 52.27, lon: 104.39, population: 0.6, tier: 'regional' },
  { code: 'KJA', name: 'Krasnoyarsk Intl', city: 'Krasnoyarsk', country: 'RU', lat: 56.17, lon: 92.49, population: 1.1, tier: 'regional' },
  { code: 'UFA', name: 'Ufa Intl', city: 'Ufa', country: 'RU', lat: 54.56, lon: 55.87, population: 1.1, tier: 'regional' },
  { code: 'ROV', name: 'Platov Intl', city: 'Rostov-on-Don', country: 'RU', lat: 47.49, lon: 39.92, population: 1.1, tier: 'regional' },
  { code: 'VOG', name: 'Volgograd Intl', city: 'Volgograd', country: 'RU', lat: 48.78, lon: 44.35, population: 1.0, tier: 'regional' },
  { code: 'OMS', name: 'Omsk Tsentralny', city: 'Omsk', country: 'RU', lat: 54.97, lon: 73.32, population: 1.2, tier: 'regional' },
  { code: 'BAX', name: 'Barnaul Airport', city: 'Barnaul', country: 'RU', lat: 53.36, lon: 83.54, population: 0.7, tier: 'regional' },
  { code: 'KEJ', name: 'Kemerovo Airport', city: 'Kemerovo', country: 'RU', lat: 55.27, lon: 86.11, population: 0.5, tier: 'regional' },
  { code: 'ABA', name: 'Abakan Intl', city: 'Abakan', country: 'RU', lat: 53.74, lon: 91.39, population: 0.2, tier: 'regional' },
  { code: 'MRV', name: 'Mineralnyye Vody Airport', city: 'Mineralnyye Vody', country: 'RU', lat: 44.22, lon: 43.08, population: 0.3, tier: 'regional' },
  { code: 'NBC', name: 'Begishevo Airport', city: 'Naberezhnye Chelny', country: 'RU', lat: 55.56, lon: 52.09, population: 0.5, tier: 'regional' },
  { code: 'TJM', name: 'Roshchino Intl', city: 'Tyumen', country: 'RU', lat: 57.19, lon: 68.56, population: 0.8, tier: 'regional' },
  { code: 'CLJ', name: 'Cluj-Napoca Intl', city: 'Cluj-Napoca', country: 'RO', lat: 46.79, lon: 23.69, population: 0.4, tier: 'regional' },
  { code: 'IAS', name: 'Iasi Intl', city: 'Iasi', country: 'RO', lat: 47.18, lon: 27.62, population: 0.4, tier: 'regional' },
  { code: 'TSR', name: 'Timisoara Traian Vuia', city: 'Timisoara', country: 'RO', lat: 45.8, lon: 21.34, population: 0.4, tier: 'regional' },
  { code: 'CND', name: 'Constanta Airport', city: 'Constanta', country: 'RO', lat: 44.36, lon: 28.49, population: 0.4, tier: 'regional' },
  { code: 'GHV', name: 'Brașov-Ghimbav Intl',          city: 'Brașov',          country: 'RO', lat: 45.66,  lon: 25.53,    population: 0.4,  tier: 'regional' },
  { code: 'SCV', name: 'Suceava Ștefan cel Mare Intl',  city: 'Suceava',         country: 'RO', lat: 47.69,  lon: 26.35,    population: 0.17, tier: 'regional' },
  { code: 'OMR', name: 'Oradea Intl',                   city: 'Oradea',          country: 'RO', lat: 47.03,  lon: 21.90,    population: 0.3,  tier: 'regional' },
  { code: 'ARW', name: 'Arad Intl',                     city: 'Arad',            country: 'RO', lat: 46.18,  lon: 21.26,    population: 0.3,  tier: 'regional' },
  { code: 'TCE', name: 'Tulcea Cataloi Airport',         city: 'Tulcea',          country: 'RO', lat: 45.06,  lon: 28.71,    population: 0.1,  tier: 'regional' },
  { code: 'TGM', name: 'Transilvania Intl',              city: 'Târgu Mureș',     country: 'RO', lat: 46.47,  lon: 24.41,    population: 0.15, tier: 'regional' },
  { code: 'SUJ', name: 'Satu Mare Intl',                 city: 'Satu Mare',       country: 'RO', lat: 47.70,  lon: 22.89,    population: 0.12, tier: 'regional' },
  { code: 'BAY', name: 'Maramureș Intl',                 city: 'Baia Mare',       country: 'RO', lat: 47.66,  lon: 23.47,    population: 0.12, tier: 'regional' },
  { code: 'GZT', name: 'Gaziantep Oguzeli Intl', city: 'Gaziantep', country: 'TR', lat: 36.95, lon: 37.48, population: 2.1, tier: 'regional' },
  { code: 'TZX', name: 'Trabzon Airport', city: 'Trabzon', country: 'TR', lat: 40.99, lon: 39.79, population: 0.8, tier: 'regional' },
  { code: 'VAN', name: 'Van Ferit Melen Airport', city: 'Van', country: 'TR', lat: 38.47, lon: 43.33, population: 0.5, tier: 'regional' },
  { code: 'MLX', name: 'Malatya Erhac Airport', city: 'Malatya', country: 'TR', lat: 38.44, lon: 38.09, population: 0.5, tier: 'regional' },
  { code: 'KYA', name: 'Konya Airport', city: 'Konya', country: 'TR', lat: 37.98, lon: 32.56, population: 2.2, tier: 'regional' },
  { code: 'SZF', name: 'Samsun-Carsamba Airport', city: 'Samsun', country: 'TR', lat: 41.25, lon: 36.57, population: 0.6, tier: 'regional' },
  { code: 'ERZ', name: 'Erzurum Airport', city: 'Erzurum', country: 'TR', lat: 39.96, lon: 41.17, population: 0.4, tier: 'regional' },
  { code: 'GZP', name: 'Gazipasa-Alanya Airport', city: 'Alanya', country: 'TR', lat: 36.3, lon: 32.3, population: 0.1, tier: 'regional' },
  { code: 'KSY', name: 'Kars Airport', city: 'Kars', country: 'TR', lat: 40.56, lon: 43.12, population: 0.1, tier: 'regional' },
  { code: 'SJJ', name: 'Sarajevo Intl', city: 'Sarajevo', country: 'BA', lat: 43.82, lon: 18.33, population: 0.5, tier: 'regional' },
  { code: 'PRN', name: 'Pristina Adem Jashari', city: 'Pristina', country: 'XK', lat: 42.57, lon: 21.04, population: 0.2, tier: 'regional' },
  { code: 'KIV', name: 'Chisinau Intl', city: 'Chisinau', country: 'MD', lat: 46.93, lon: 28.93, population: 0.8, tier: 'regional' },
  { code: 'ODS', name: 'Odesa Intl', city: 'Odesa', country: 'UA', lat: 46.43, lon: 30.68, population: 1.0, tier: 'regional' },
  { code: 'HRK', name: 'Kharkiv Intl', city: 'Kharkiv', country: 'UA', lat: 49.92, lon: 36.29, population: 1.4, tier: 'regional' },
  { code: 'DNK', name: 'Dnipro Intl', city: 'Dnipro', country: 'UA', lat: 48.36, lon: 35.1, population: 1.0, tier: 'regional' },
  { code: 'HAJ', name: 'Hannover Airport', city: 'Hannover', country: 'DE', lat: 52.46, lon: 9.69, population: 0.5, tier: 'regional' },
  { code: 'SCN', name: 'Saarbrucken Airport', city: 'Saarbrucken', country: 'DE', lat: 49.21, lon: 7.11, population: 0.2, tier: 'regional' },
  { code: 'FKB', name: 'Karlsruhe Baden-Baden Airport', city: 'Karlsruhe', country: 'DE', lat: 48.78, lon: 8.08, population: 0.3, tier: 'regional' },
  { code: 'ERF', name: 'Erfurt-Weimar Airport', city: 'Erfurt', country: 'DE', lat: 50.98, lon: 10.96, population: 0.2, tier: 'regional' },
  { code: 'RLG', name: 'Rostock-Laage Airport', city: 'Rostock', country: 'DE', lat: 53.92, lon: 12.28, population: 0.2, tier: 'regional' },
  { code: 'BOH', name: 'Bournemouth Airport', city: 'Bournemouth', country: 'GB', lat: 50.78, lon: -1.83, population: 0.2, tier: 'regional' },
  { code: 'EXT', name: 'Exeter Airport', city: 'Exeter', country: 'GB', lat: 50.73, lon: -3.41, population: 0.3, tier: 'regional' },
  { code: 'INV', name: 'Inverness Airport', city: 'Inverness', country: 'GB', lat: 57.54, lon: -4.05, population: 0.05, tier: 'regional' },
  { code: 'SOU', name: 'Southampton Airport', city: 'Southampton', country: 'GB', lat: 50.95, lon: -1.36, population: 0.7, tier: 'regional' },
  { code: 'NQY', name: 'Newquay Airport', city: 'Newquay', country: 'GB', lat: 50.44, lon: -5.0, population: 0.06, tier: 'regional' },
  { code: 'ALY', name: 'El Nouzha Airport', city: 'Alexandria', country: 'EG', lat: 31.18, lon: 29.95, population: 5.2, tier: 'regional' },
  { code: 'ASM', name: 'Asmara Intl', city: 'Asmara', country: 'ER', lat: 15.29, lon: 38.91, population: 0.9, tier: 'regional' },
  { code: 'BGF', name: "Bangui M'Poko Intl", city: 'Bangui', country: 'CF', lat: 4.4, lon: 18.52, population: 0.8, tier: 'regional' },
  { code: 'BJL', name: 'Banjul Intl', city: 'Banjul', country: 'GM', lat: 13.34, lon: -16.65, population: 0.5, tier: 'regional' },
  { code: 'CBQ', name: 'Margaret Ekpo Intl', city: 'Calabar', country: 'NG', lat: 4.98, lon: 8.35, population: 0.5, tier: 'regional' },
  { code: 'DJE', name: 'Djerba-Zarzis Intl', city: 'Djerba', country: 'TN', lat: 33.87, lon: 10.78, population: 0.1, tier: 'regional' },
  { code: 'DSS', name: 'Blaise Diagne Intl', city: 'Dakar', country: 'SN', lat: 14.67, lon: -17.07, population: 3.8, tier: 'regional' },
  { code: 'ENU', name: 'Akanu Ibiam Intl', city: 'Enugu', country: 'NG', lat: 6.47, lon: 7.56, population: 0.7, tier: 'regional' },
  { code: 'HGA', name: 'Egal Intl', city: 'Hargeisa', country: 'SO', lat: 9.52, lon: 44.09, population: 1.5, tier: 'regional' },
  { code: 'JIB', name: 'Djibouti-Ambouli Intl', city: 'Djibouti', country: 'DJ', lat: 11.55, lon: 43.16, population: 1.1, tier: 'regional' },
  { code: 'JOS', name: 'Yakubu Gowon Airport', city: 'Jos', country: 'NG', lat: 9.64, lon: 8.87, population: 0.9, tier: 'regional' },
  { code: 'KAN', name: 'Mallam Aminu Kano Intl', city: 'Kano', country: 'NG', lat: 12.05, lon: 8.52, population: 4.0, tier: 'regional' },
  { code: 'KIS', name: 'Kisumu Intl', city: 'Kisumu', country: 'KE', lat: -0.09, lon: 34.73, population: 0.5, tier: 'regional' },
  { code: 'LAD', name: 'Quatro de Fevereiro', city: 'Luanda', country: 'AO', lat: -8.86, lon: 13.23, population: 7.5, tier: 'major' },
  { code: 'MBA', name: 'Mombasa Moi Intl', city: 'Mombasa', country: 'KE', lat: -4.03, lon: 39.59, population: 1.2, tier: 'regional' },
  { code: 'MWZ', name: 'Mwanza Airport', city: 'Mwanza', country: 'TZ', lat: -2.44, lon: 32.93, population: 0.9, tier: 'regional' },
  { code: 'NBE', name: 'Enfidha-Hammamet Intl', city: 'Enfidha', country: 'TN', lat: 36.08, lon: 10.44, population: 0.2, tier: 'regional' },
  { code: 'NKC', name: 'Nouakchott Oumtounsy Intl', city: 'Nouakchott', country: 'MR', lat: 18.1, lon: -15.95, population: 1.2, tier: 'regional' },
  { code: 'ORN', name: 'Oran Ahmed Ben Bella Intl', city: 'Oran', country: 'DZ', lat: 35.62, lon: -0.62, population: 1.8, tier: 'regional' },
  { code: 'OXB', name: 'Osvaldo Vieira Intl', city: 'Bissau', country: 'GW', lat: 11.89, lon: -15.65, population: 0.5, tier: 'regional' },
  { code: 'PNR', name: 'Pointe-Noire Airport', city: 'Pointe-Noire', country: 'CG', lat: -4.82, lon: 11.89, population: 1.0, tier: 'regional' },
  { code: 'RBA', name: 'Rabat-Sale Airport', city: 'Rabat', country: 'MA', lat: 34.05, lon: -6.75, population: 1.9, tier: 'regional' },
  { code: 'RUN', name: 'Roland Garros Airport', city: 'Saint-Denis Reunion', country: 'RE', lat: -20.89, lon: 55.51, population: 0.3, tier: 'regional' },
  { code: 'SEZ', name: 'Seychelles Intl', city: 'Victoria Seychelles', country: 'SC', lat: -4.67, lon: 55.52, population: 0.1, tier: 'regional' },
  { code: 'SID', name: 'Amilcar Cabral Intl', city: 'Sal Island', country: 'CV', lat: 16.74, lon: -22.95, population: 0.05, tier: 'regional' },
  { code: 'TMS', name: 'Sao Tome Intl', city: 'Sao Tome', country: 'ST', lat: 0.38, lon: 6.71, population: 0.07, tier: 'regional' },
  { code: 'TNG', name: 'Ibn Battuta Airport', city: 'Tangier', country: 'MA', lat: 35.73, lon: -5.92, population: 1.0, tier: 'regional' },
  { code: 'ZNZ', name: 'Abeid Amani Karume Intl', city: 'Zanzibar', country: 'TZ', lat: -6.22, lon: 39.22, population: 0.4, tier: 'regional' },
  { code: 'CZL', name: 'Mohamed Boudiaf Intl', city: 'Constantine', country: 'DZ', lat: 36.28, lon: 6.62, population: 1.0, tier: 'regional' },
  { code: 'MJI', name: 'Mitiga Airport', city: 'Tripoli', country: 'LY', lat: 32.89, lon: 13.28, population: 3.5, tier: 'regional' },
  { code: 'SFX', name: 'Sfax Thyna Intl', city: 'Sfax', country: 'TN', lat: 34.72, lon: 10.69, population: 0.3, tier: 'regional' },
  { code: 'PHG', name: 'Port Harcourt Intl', city: 'Port Harcourt', country: 'NG', lat: 4.01, lon: 7.2, population: 1.9, tier: 'regional' },
  { code: 'ILR', name: 'Ilorin Intl', city: 'Ilorin', country: 'NG', lat: 8.44, lon: 4.49, population: 0.8, tier: 'regional' },
  { code: 'MIU', name: 'Maiduguri Intl', city: 'Maiduguri', country: 'NG', lat: 11.85, lon: 13.08, population: 0.8, tier: 'regional' },
  { code: 'SKO', name: 'Sadiq Abubakar III Intl', city: 'Sokoto', country: 'NG', lat: 12.92, lon: 5.21, population: 0.8, tier: 'regional' },
  { code: 'MYD', name: 'Malindi Airport', city: 'Malindi', country: 'KE', lat: -3.23, lon: 40.1, population: 0.2, tier: 'regional' },
  { code: 'MUB', name: 'Maun Airport', city: 'Maun', country: 'BW', lat: -19.97, lon: 23.43, population: 0.07, tier: 'regional' },
  { code: 'ADE', name: 'Aden Intl', city: 'Aden', country: 'YE', lat: 12.83, lon: 45.03, population: 1.0, tier: 'regional' },
  { code: 'AQJ', name: 'King Hussein Intl', city: 'Aqaba', country: 'JO', lat: 29.61, lon: 35.02, population: 0.2, tier: 'regional' },
  { code: 'EBL', name: 'Erbil Intl', city: 'Erbil', country: 'IQ', lat: 36.23, lon: 44.0, population: 1.5, tier: 'regional' },
  { code: 'NJF', name: 'Al Najaf Intl', city: 'Najaf', country: 'IQ', lat: 31.99, lon: 44.4, population: 2.0, tier: 'regional' },
  { code: 'OSM', name: 'Mosul Airport', city: 'Mosul', country: 'IQ', lat: 36.31, lon: 43.15, population: 1.8, tier: 'regional' },
  { code: 'BSR', name: 'Basra Intl', city: 'Basra', country: 'IQ', lat: 30.55, lon: 47.66, population: 3.0, tier: 'regional' },
  { code: 'SAH', name: 'Sanaa Intl', city: 'Sanaa', country: 'YE', lat: 15.48, lon: 44.22, population: 3.9, tier: 'regional' },
  { code: 'TIF', name: 'Taif Regional Airport', city: 'Taif', country: 'SA', lat: 21.48, lon: 40.54, population: 1.1, tier: 'regional' },
  { code: 'GIZ', name: 'Jizan Regional Airport', city: 'Jizan', country: 'SA', lat: 16.9, lon: 42.58, population: 0.5, tier: 'regional' },
  { code: 'HOF', name: 'Al-Ahsa Intl', city: 'Al-Ahsa', country: 'SA', lat: 25.29, lon: 49.48, population: 1.1, tier: 'regional' },
  { code: 'ELQ', name: 'Prince Nayef bin Abdulaziz', city: 'Qassim', country: 'SA', lat: 26.3, lon: 43.77, population: 1.3, tier: 'regional' },
  { code: 'TUU', name: 'Tabuk Regional Airport', city: 'Tabuk', country: 'SA', lat: 28.37, lon: 36.62, population: 0.8, tier: 'regional' },
  { code: 'AHB', name: 'Abha Regional Airport', city: 'Abha', country: 'SA', lat: 18.24, lon: 42.66, population: 1.1, tier: 'regional' },
  { code: 'HAS', name: 'Hail Regional Airport', city: 'Hail', country: 'SA', lat: 27.44, lon: 41.69, population: 0.7, tier: 'regional' },
  { code: 'YNB', name: 'Prince Abdulmohsen Intl', city: 'Yanbu', country: 'SA', lat: 24.14, lon: 38.06, population: 0.2, tier: 'regional' },
  { code: 'SLL', name: 'Salalah Airport', city: 'Salalah', country: 'OM', lat: 17.04, lon: 54.09, population: 0.3, tier: 'regional' },
  { code: 'KHS', name: 'Khasab Airport', city: 'Khasab', country: 'OM', lat: 26.17, lon: 56.24, population: 0.02, tier: 'regional' },
  { code: 'ATQ', name: 'Sri Guru Ram Dass Jee Intl', city: 'Amritsar', country: 'IN', lat: 31.71, lon: 74.8, population: 1.1, tier: 'regional' },
  { code: 'BBI', name: 'Biju Patnaik Intl', city: 'Bhubaneswar', country: 'IN', lat: 20.24, lon: 85.82, population: 1.0, tier: 'regional' },
  { code: 'BHO', name: 'Raja Bhoj Airport', city: 'Bhopal', country: 'IN', lat: 23.29, lon: 77.34, population: 1.9, tier: 'regional' },
  { code: 'CJB', name: 'Coimbatore Intl', city: 'Coimbatore', country: 'IN', lat: 11.03, lon: 77.04, population: 2.2, tier: 'regional' },
  { code: 'GAU', name: 'Lokpriya Gopinath Bordoloi', city: 'Guwahati', country: 'IN', lat: 26.11, lon: 91.59, population: 1.1, tier: 'regional' },
  { code: 'IXB', name: 'Bagdogra Airport', city: 'Siliguri', country: 'IN', lat: 26.68, lon: 88.33, population: 1.3, tier: 'regional' },
  { code: 'IXC', name: 'Chandigarh Intl', city: 'Chandigarh', country: 'IN', lat: 30.67, lon: 76.79, population: 1.0, tier: 'regional' },
  { code: 'IXJ', name: 'Jammu Airport', city: 'Jammu', country: 'IN', lat: 32.69, lon: 74.84, population: 0.7, tier: 'regional' },
  { code: 'IXL', name: 'Kushok Bakula Rimpochee', city: 'Leh', country: 'IN', lat: 34.14, lon: 77.55, population: 0.3, tier: 'regional' },
  { code: 'IXR', name: 'Birsa Munda Airport', city: 'Ranchi', country: 'IN', lat: 23.31, lon: 85.32, population: 1.5, tier: 'regional' },
  { code: 'NAG', name: 'Dr. Babasaheb Ambedkar Intl', city: 'Nagpur', country: 'IN', lat: 21.09, lon: 79.05, population: 2.5, tier: 'regional' },
  { code: 'PAT', name: 'Lok Nayak Jayaprakash', city: 'Patna', country: 'IN', lat: 25.59, lon: 85.09, population: 2.5, tier: 'regional' },
  { code: 'RAJ', name: 'Rajkot Intl', city: 'Rajkot', country: 'IN', lat: 22.31, lon: 70.78, population: 1.5, tier: 'regional' },
  { code: 'STV', name: 'Surat Airport', city: 'Surat', country: 'IN', lat: 21.11, lon: 72.74, population: 7.2, tier: 'regional' },
  { code: 'TRV', name: 'Trivandrum Intl', city: 'Thiruvananthapuram', country: 'IN', lat: 8.48, lon: 76.92, population: 2.1, tier: 'regional' },
  { code: 'VGA', name: 'Vijayawada Airport', city: 'Vijayawada', country: 'IN', lat: 16.53, lon: 80.8, population: 1.5, tier: 'regional' },
  { code: 'VTZ', name: 'Visakhapatnam Intl', city: 'Visakhapatnam', country: 'IN', lat: 17.72, lon: 83.22, population: 2.0, tier: 'regional' },
  { code: 'IXM', name: 'Madurai Airport', city: 'Madurai', country: 'IN', lat: 9.83, lon: 78.09, population: 1.5, tier: 'regional' },
  { code: 'TRZ', name: 'Tiruchirappalli Intl', city: 'Tiruchirappalli', country: 'IN', lat: 10.77, lon: 78.71, population: 1.0, tier: 'regional' },
  { code: 'CCJ', name: 'Calicut Intl', city: 'Kozhikode', country: 'IN', lat: 11.14, lon: 75.95, population: 2.1, tier: 'regional' },
  { code: 'IDR', name: 'Devi Ahilyabai Holkar', city: 'Indore', country: 'IN', lat: 22.72, lon: 75.8, population: 2.2, tier: 'regional' },
  { code: 'VNS', name: 'Lal Bahadur Shastri Intl', city: 'Varanasi', country: 'IN', lat: 25.45, lon: 82.86, population: 1.4, tier: 'regional' },
  { code: 'RPR', name: 'Swami Vivekananda Airport', city: 'Raipur', country: 'IN', lat: 21.18, lon: 81.74, population: 1.3, tier: 'regional' },
  { code: 'BDQ', name: 'Vadodara Airport', city: 'Vadodara', country: 'IN', lat: 22.34, lon: 73.23, population: 2.1, tier: 'regional' },
  { code: 'IXZ', name: 'Veer Savarkar Intl', city: 'Port Blair', country: 'IN', lat: 11.64, lon: 92.73, population: 0.4, tier: 'regional' },
  { code: 'AGR', name: 'Agra Airport', city: 'Agra', country: 'IN', lat: 27.16, lon: 77.96, population: 1.7, tier: 'regional' },
  { code: 'DIB', name: 'Dibrugarh Airport', city: 'Dibrugarh', country: 'IN', lat: 27.48, lon: 95.02, population: 0.5, tier: 'regional' },
  { code: 'JRH', name: 'Jorhat Airport', city: 'Jorhat', country: 'IN', lat: 26.73, lon: 94.18, population: 0.4, tier: 'regional' },
  { code: 'SKT', name: 'Sialkot Intl', city: 'Sialkot', country: 'PK', lat: 32.54, lon: 74.36, population: 0.7, tier: 'regional' },
  { code: 'CGO', name: 'Zhengzhou Xinzheng Intl', city: 'Zhengzhou', country: 'CN', lat: 34.52, lon: 113.84, population: 10.5, tier: 'major' },
  { code: 'FOC', name: 'Fuzhou Changle Intl', city: 'Fuzhou', country: 'CN', lat: 25.93, lon: 119.66, population: 8.1, tier: 'major' },
  { code: 'HFE', name: 'Hefei Xinqiao Intl', city: 'Hefei', country: 'CN', lat: 31.33, lon: 116.98, population: 8.4, tier: 'major' },
  { code: 'KHN', name: 'Nanchang Changbei Intl', city: 'Nanchang', country: 'CN', lat: 28.86, lon: 115.9, population: 6.0, tier: 'regional' },
  { code: 'KWE', name: 'Guiyang Longdongbao Intl', city: 'Guiyang', country: 'CN', lat: 26.54, lon: 106.8, population: 5.0, tier: 'regional' },
  { code: 'LHW', name: 'Lanzhou Zhongchuan Intl', city: 'Lanzhou', country: 'CN', lat: 36.52, lon: 103.62, population: 4.0, tier: 'regional' },
  { code: 'LJG', name: 'Lijiang Sanyi Intl', city: 'Lijiang', country: 'CN', lat: 26.68, lon: 100.25, population: 1.3, tier: 'regional' },
  { code: 'LXA', name: 'Lhasa Gonggar Airport', city: 'Lhasa', country: 'CN', lat: 29.3, lon: 90.91, population: 0.8, tier: 'regional' },
  { code: 'NGB', name: 'Ningbo Lishe Intl', city: 'Ningbo', country: 'CN', lat: 29.83, lon: 121.46, population: 8.2, tier: 'major' },
  { code: 'SJW', name: 'Shijiazhuang Zhengding', city: 'Shijiazhuang', country: 'CN', lat: 38.28, lon: 114.7, population: 11.0, tier: 'major' },
  { code: 'SYX', name: 'Sanya Phoenix Intl', city: 'Sanya', country: 'CN', lat: 18.3, lon: 109.41, population: 0.7, tier: 'regional' },
  { code: 'TSN', name: 'Tianjin Binhai Intl', city: 'Tianjin', country: 'CN', lat: 39.12, lon: 117.35, population: 13.6, tier: 'major' },
  { code: 'TYN', name: 'Taiyuan Wusu Intl', city: 'Taiyuan', country: 'CN', lat: 37.75, lon: 112.63, population: 5.3, tier: 'regional' },
  { code: 'WNZ', name: 'Wenzhou Longwan Intl', city: 'Wenzhou', country: 'CN', lat: 27.91, lon: 120.85, population: 9.3, tier: 'major' },
  { code: 'XNN', name: 'Xining Caojiabao Intl', city: 'Xining', country: 'CN', lat: 36.53, lon: 102.04, population: 2.4, tier: 'regional' },
  { code: 'YNT', name: 'Yantai Penglai Intl', city: 'Yantai', country: 'CN', lat: 37.66, lon: 120.99, population: 7.1, tier: 'regional' },
  { code: 'ZUH', name: 'Zhuhai Jinwan Airport', city: 'Zhuhai', country: 'CN', lat: 22.0, lon: 113.38, population: 2.5, tier: 'regional' },
  { code: 'SZX', name: 'Shenzhen Baoan Intl', city: 'Shenzhen', country: 'CN', lat: 22.64, lon: 113.81, population: 17.5, tier: 'mega' },
  { code: 'MIG', name: 'Mianyang Nanjiao Airport', city: 'Mianyang', country: 'CN', lat: 31.43, lon: 104.74, population: 5.0, tier: 'regional' },
  { code: 'INC', name: 'Yinchuan Hedong Intl', city: 'Yinchuan', country: 'CN', lat: 38.32, lon: 106.39, population: 2.9, tier: 'regional' },
  { code: 'BAV', name: 'Baotou Airport', city: 'Baotou', country: 'CN', lat: 40.56, lon: 109.99, population: 2.7, tier: 'regional' },
  { code: 'YIW', name: 'Yiwu Airport', city: 'Yiwu', country: 'CN', lat: 29.34, lon: 120.03, population: 1.8, tier: 'regional' },
  { code: 'KHG', name: 'Kashgar Airport', city: 'Kashgar', country: 'CN', lat: 39.54, lon: 76.02, population: 0.7, tier: 'regional' },
  { code: 'LYA', name: 'Luoyang Beijiao Airport', city: 'Luoyang', country: 'CN', lat: 34.74, lon: 112.39, population: 7.0, tier: 'regional' },
  { code: 'ZYI', name: 'Zunyi Xinzhou Airport', city: 'Zunyi', country: 'CN', lat: 27.59, lon: 107.01, population: 6.8, tier: 'regional' },
  { code: 'WDS', name: 'Shiyan Wudangshan Airport', city: 'Shiyan', country: 'CN', lat: 32.59, lon: 110.91, population: 3.4, tier: 'regional' },
  { code: 'ENH', name: 'Enshi Xujiaping Airport', city: 'Enshi', country: 'CN', lat: 30.32, lon: 109.49, population: 3.8, tier: 'regional' },
  { code: 'JGN', name: 'Jiayuguan Airport', city: 'Jiayuguan', country: 'CN', lat: 39.86, lon: 98.34, population: 0.3, tier: 'regional' },
  { code: 'HIJ', name: 'Hiroshima Airport', city: 'Hiroshima', country: 'JP', lat: 34.44, lon: 132.92, population: 2.9, tier: 'regional' },
  { code: 'KMI', name: 'Miyazaki Airport', city: 'Miyazaki', country: 'JP', lat: 31.88, lon: 131.45, population: 0.4, tier: 'regional' },
  { code: 'KMJ', name: 'Kumamoto Airport', city: 'Kumamoto', country: 'JP', lat: 32.84, lon: 130.86, population: 0.7, tier: 'regional' },
  { code: 'KOJ', name: 'Kagoshima Airport', city: 'Kagoshima', country: 'JP', lat: 31.8, lon: 130.72, population: 0.6, tier: 'regional' },
  { code: 'NGS', name: 'Nagasaki Airport', city: 'Nagasaki', country: 'JP', lat: 32.92, lon: 129.92, population: 0.4, tier: 'regional' },
  { code: 'OIT', name: 'Oita Airport', city: 'Oita', country: 'JP', lat: 33.48, lon: 131.74, population: 0.5, tier: 'regional' },
  { code: 'TOY', name: 'Toyama Airport', city: 'Toyama', country: 'JP', lat: 36.65, lon: 137.19, population: 0.4, tier: 'regional' },
  { code: 'TAK', name: 'Takamatsu Airport', city: 'Takamatsu', country: 'JP', lat: 34.21, lon: 134.02, population: 0.4, tier: 'regional' },
  { code: 'KCZ', name: 'Kochi Ryoma Airport', city: 'Kochi', country: 'JP', lat: 33.55, lon: 133.67, population: 0.3, tier: 'regional' },
  { code: 'MYJ', name: 'Matsuyama Airport', city: 'Matsuyama', country: 'JP', lat: 33.83, lon: 132.7, population: 0.5, tier: 'regional' },
  { code: 'AOJ', name: 'Aomori Airport', city: 'Aomori', country: 'JP', lat: 40.73, lon: 140.69, population: 0.3, tier: 'regional' },
  { code: 'AXT', name: 'Akita Airport', city: 'Akita', country: 'JP', lat: 39.62, lon: 140.22, population: 0.3, tier: 'regional' },
  { code: 'GAJ', name: 'Yamagata Airport', city: 'Yamagata', country: 'JP', lat: 38.41, lon: 140.37, population: 0.3, tier: 'regional' },
  { code: 'FSZ', name: 'Shizuoka Airport', city: 'Shizuoka', country: 'JP', lat: 34.8, lon: 138.19, population: 0.7, tier: 'regional' },
  { code: 'KKJ', name: 'Kitakyushu Airport', city: 'Kitakyushu', country: 'JP', lat: 33.85, lon: 131.04, population: 1.0, tier: 'regional' },
  { code: 'TTJ', name: 'Tottori Airport', city: 'Tottori', country: 'JP', lat: 35.53, lon: 134.17, population: 0.2, tier: 'regional' },
  { code: 'MMY', name: 'Miyako Airport', city: 'Miyako', country: 'JP', lat: 24.78, lon: 125.3, population: 0.06, tier: 'regional' },
  { code: 'ISG', name: 'Ishigaki Airport', city: 'Ishigaki', country: 'JP', lat: 24.34, lon: 124.19, population: 0.05, tier: 'regional' },
  { code: 'ASJ', name: 'Amami Airport', city: 'Amami', country: 'JP', lat: 28.43, lon: 129.71, population: 0.07, tier: 'regional' },
  { code: 'CJJ', name: 'Cheongju Airport', city: 'Cheongju', country: 'KR', lat: 36.72, lon: 127.5, population: 0.8, tier: 'regional' },
  { code: 'KWJ', name: 'Gwangju Airport', city: 'Gwangju', country: 'KR', lat: 35.13, lon: 126.81, population: 1.5, tier: 'regional' },
  { code: 'RSU', name: 'Yeosu Airport', city: 'Yeosu', country: 'KR', lat: 34.84, lon: 127.62, population: 0.3, tier: 'regional' },
  { code: 'USN', name: 'Ulsan Airport', city: 'Ulsan', country: 'KR', lat: 35.59, lon: 129.35, population: 1.2, tier: 'regional' },
  { code: 'MWX', name: 'Muan Intl', city: 'Muan', country: 'KR', lat: 34.99, lon: 126.38, population: 0.8, tier: 'regional' },
  { code: 'BDJ', name: 'Syamsudin Noor Intl', city: 'Banjarmasin', country: 'ID', lat: -3.44, lon: 114.76, population: 0.7, tier: 'regional' },
  { code: 'BTH', name: 'Hang Nadim Airport', city: 'Batam', country: 'ID', lat: 1.12, lon: 104.12, population: 1.2, tier: 'regional' },
  { code: 'LOP', name: 'Lombok Intl', city: 'Praya', country: 'ID', lat: -8.76, lon: 116.28, population: 1.1, tier: 'regional' },
  { code: 'MDC', name: 'Sam Ratulangi Intl', city: 'Manado', country: 'ID', lat: 1.55, lon: 124.93, population: 0.6, tier: 'regional' },
  { code: 'PDG', name: 'Minangkabau Intl', city: 'Padang', country: 'ID', lat: -0.79, lon: 100.28, population: 1.0, tier: 'regional' },
  { code: 'PLM', name: 'Sultan Mahmud Badaruddin II', city: 'Palembang', country: 'ID', lat: -2.9, lon: 104.7, population: 1.9, tier: 'regional' },
  { code: 'PKU', name: 'Sultan Syarif Kasim II', city: 'Pekanbaru', country: 'ID', lat: 0.46, lon: 101.44, population: 1.0, tier: 'regional' },
  { code: 'SRG', name: 'Ahmad Yani Intl', city: 'Semarang', country: 'ID', lat: -6.97, lon: 110.37, population: 1.8, tier: 'regional' },
  { code: 'TKG', name: 'Radin Inten II Intl', city: 'Bandar Lampung', country: 'ID', lat: -5.24, lon: 105.18, population: 1.0, tier: 'regional' },
  { code: 'CRK', name: 'Clark Intl', city: 'Angeles City', country: 'PH', lat: 15.19, lon: 120.56, population: 0.5, tier: 'regional' },
  { code: 'KLO', name: 'Kalibo Intl', city: 'Kalibo', country: 'PH', lat: 11.68, lon: 122.38, population: 0.1, tier: 'regional' },
  { code: 'PPS', name: 'Puerto Princesa Intl', city: 'Puerto Princesa', country: 'PH', lat: 9.74, lon: 118.76, population: 0.3, tier: 'regional' },
  { code: 'TAG', name: 'Tagbilaran Airport', city: 'Tagbilaran', country: 'PH', lat: 9.66, lon: 123.85, population: 0.2, tier: 'regional' },
  { code: 'ZAM', name: 'Zamboanga Intl', city: 'Zamboanga', country: 'PH', lat: 6.92, lon: 122.06, population: 0.9, tier: 'regional' },
  { code: 'HPH', name: 'Cat Bi Intl', city: 'Haiphong', country: 'VN', lat: 20.82, lon: 106.72, population: 2.3, tier: 'regional' },
  { code: 'HUI', name: 'Phu Bai Intl', city: 'Hue', country: 'VN', lat: 16.4, lon: 107.7, population: 0.4, tier: 'regional' },
  { code: 'PQC', name: 'Phu Quoc Intl', city: 'Phu Quoc', country: 'VN', lat: 10.23, lon: 103.97, population: 0.2, tier: 'regional' },
  { code: 'UIH', name: 'Phu Cat Airport', city: 'Quy Nhon', country: 'VN', lat: 13.95, lon: 109.04, population: 0.5, tier: 'regional' },
  { code: 'VCA', name: 'Can Tho Intl', city: 'Can Tho', country: 'VN', lat: 10.08, lon: 105.71, population: 1.4, tier: 'regional' },
  { code: 'BMV', name: 'Buon Ma Thuot Airport', city: 'Buon Ma Thuot', country: 'VN', lat: 12.67, lon: 108.12, population: 0.6, tier: 'regional' },
  { code: 'HDY', name: 'Hat Yai Intl', city: 'Hat Yai', country: 'TH', lat: 6.93, lon: 100.39, population: 1.5, tier: 'regional' },
  { code: 'NST', name: 'Nakhon Si Thammarat Airport', city: 'Nakhon Si Thammarat', country: 'TH', lat: 8.54, lon: 100.08, population: 0.5, tier: 'regional' },
  { code: 'UBP', name: 'Ubon Ratchathani Airport', city: 'Ubon Ratchathani', country: 'TH', lat: 15.25, lon: 104.87, population: 0.4, tier: 'regional' },
  { code: 'UTP', name: 'U-Tapao Intl', city: 'Pattaya', country: 'TH', lat: 12.68, lon: 101.0, population: 0.5, tier: 'regional' },
  { code: 'MDL', name: 'Mandalay Intl', city: 'Mandalay', country: 'MM', lat: 21.7, lon: 95.98, population: 1.5, tier: 'regional' },
  { code: 'NYT', name: 'Naypyidaw Intl', city: 'Naypyidaw', country: 'MM', lat: 19.62, lon: 96.2, population: 1.2, tier: 'regional' },
  { code: 'IPH', name: 'Sultan Azlan Shah Airport', city: 'Ipoh', country: 'MY', lat: 4.57, lon: 101.09, population: 0.8, tier: 'regional' },
  { code: 'KBR', name: 'Sultan Ismail Petra Airport', city: 'Kota Bharu', country: 'MY', lat: 6.17, lon: 102.29, population: 0.6, tier: 'regional' },
  { code: 'KUA', name: 'Kuantan Airport', city: 'Kuantan', country: 'MY', lat: 3.78, lon: 103.21, population: 0.4, tier: 'regional' },
  { code: 'MYY', name: 'Miri Airport', city: 'Miri', country: 'MY', lat: 4.32, lon: 113.99, population: 0.3, tier: 'regional' },
  { code: 'SDK', name: 'Sandakan Airport', city: 'Sandakan', country: 'MY', lat: 5.9, lon: 118.06, population: 0.4, tier: 'regional' },
  { code: 'TGG', name: 'Sultan Mahmud Intl', city: 'Kuala Terengganu', country: 'MY', lat: 5.38, lon: 103.1, population: 0.4, tier: 'regional' },
  { code: 'TWU', name: 'Tawau Airport', city: 'Tawau', country: 'MY', lat: 4.32, lon: 118.13, population: 0.2, tier: 'regional' },
  { code: 'CIT', name: 'Shymkent Intl', city: 'Shymkent', country: 'KZ', lat: 42.36, lon: 69.48, population: 1.1, tier: 'regional' },
  { code: 'GUW', name: 'Atyrau Airport', city: 'Atyrau', country: 'KZ', lat: 47.12, lon: 51.82, population: 0.3, tier: 'regional' },
  { code: 'SCO', name: 'Aktau Airport', city: 'Aktau', country: 'KZ', lat: 43.86, lon: 51.09, population: 0.2, tier: 'regional' },
  { code: 'KSN', name: 'Kostanay Airport', city: 'Kostanay', country: 'KZ', lat: 53.21, lon: 63.55, population: 0.5, tier: 'regional' },
  { code: 'PLX', name: 'Semey Airport', city: 'Semey', country: 'KZ', lat: 50.35, lon: 80.23, population: 0.3, tier: 'regional' },
  { code: 'UKK', name: 'Ust-Kamenogorsk Airport', city: 'Ust-Kamenogorsk', country: 'KZ', lat: 50.04, lon: 82.49, population: 0.3, tier: 'regional' },
  { code: 'OSS', name: 'Osh Airport', city: 'Osh', country: 'KG', lat: 40.61, lon: 72.79, population: 0.3, tier: 'regional' },
  { code: 'TSV', name: 'Townsville Airport', city: 'Townsville', country: 'AU', lat: -19.25, lon: 146.77, population: 0.2, tier: 'regional' },
  { code: 'MKY', name: 'Mackay Airport', city: 'Mackay', country: 'AU', lat: -21.17, lon: 149.18, population: 0.1, tier: 'regional' },
  { code: 'ROK', name: 'Rockhampton Airport', city: 'Rockhampton', country: 'AU', lat: -23.38, lon: 150.47, population: 0.1, tier: 'regional' },
  { code: 'HTI', name: 'Hamilton Island Airport', city: 'Hamilton Island', country: 'AU', lat: -20.36, lon: 148.95, population: 0.01, tier: 'regional' },
  { code: 'MCY', name: 'Sunshine Coast Airport', city: 'Sunshine Coast', country: 'AU', lat: -26.6, lon: 153.09, population: 0.5, tier: 'regional' },
  { code: 'LST', name: 'Launceston Airport', city: 'Launceston', country: 'AU', lat: -41.54, lon: 147.21, population: 0.1, tier: 'regional' },
  { code: 'PHE', name: 'Port Hedland Intl', city: 'Port Hedland', country: 'AU', lat: -20.38, lon: 118.63, population: 0.01, tier: 'regional' },
  { code: 'KTA', name: 'Karratha Airport', city: 'Karratha', country: 'AU', lat: -20.71, lon: 116.77, population: 0.03, tier: 'regional' },
  { code: 'APW', name: 'Faleolo Intl', city: 'Apia', country: 'WS', lat: -13.83, lon: -172.01, population: 0.2, tier: 'regional' },
  { code: 'TBU', name: 'Fuaamotu Intl', city: 'Nukualofa', country: 'TO', lat: -21.24, lon: -175.15, population: 0.1, tier: 'regional' },
  { code: 'TRW', name: 'Bonriki Intl', city: 'Tarawa', country: 'KI', lat: 1.38, lon: 173.15, population: 0.06, tier: 'regional' },
  { code: 'ABE', name: 'Lehigh Valley Intl', city: 'Allentown', country: 'US', lat: 40.65, lon: -75.44, population: 0.8, tier: 'regional' },
  { code: 'ACT', name: 'Waco Regional Airport', city: 'Waco', country: 'US', lat: 31.61, lon: -97.23, population: 0.3, tier: 'regional' },
  { code: 'AGS', name: 'Augusta Regional Airport', city: 'Augusta', country: 'US', lat: 33.37, lon: -81.96, population: 0.6, tier: 'regional' },
  { code: 'FSM', name: 'Fort Smith Regional', city: 'Fort Smith', country: 'US', lat: 35.34, lon: -94.37, population: 0.3, tier: 'regional' },
  { code: 'GGG', name: 'East Texas Regional', city: 'Longview TX', country: 'US', lat: 32.38, lon: -94.71, population: 0.2, tier: 'regional' },
  { code: 'GNV', name: 'Gainesville Regional', city: 'Gainesville FL', country: 'US', lat: 29.69, lon: -82.27, population: 0.3, tier: 'regional' },
  { code: 'HLN', name: 'Helena Regional Airport', city: 'Helena', country: 'US', lat: 46.61, lon: -111.98, population: 0.08, tier: 'regional' },
  { code: 'JLN', name: 'Joplin Regional Airport', city: 'Joplin', country: 'US', lat: 37.15, lon: -94.5, population: 0.2, tier: 'regional' },
  { code: 'LBF', name: 'North Platte Regional', city: 'North Platte NE', country: 'US', lat: 41.13, lon: -100.68, population: 0.03, tier: 'regional' },
  { code: 'MFE', name: 'McAllen Miller Intl', city: 'McAllen', country: 'US', lat: 26.18, lon: -98.24, population: 1.0, tier: 'regional' },
  { code: 'MLU', name: 'Monroe Regional', city: 'Monroe LA', country: 'US', lat: 32.51, lon: -92.04, population: 0.2, tier: 'regional' },
  { code: 'MOD', name: 'Modesto City-County', city: 'Modesto', country: 'US', lat: 37.63, lon: -120.95, population: 0.5, tier: 'regional' },
  { code: 'OTZ', name: 'Ralph Wien Memorial', city: 'Kotzebue', country: 'US', lat: 66.88, lon: -162.6, population: 0.003, tier: 'regional' },
  { code: 'PIH', name: 'Pocatello Regional', city: 'Pocatello', country: 'US', lat: 42.91, lon: -112.6, population: 0.08, tier: 'regional' },
  { code: 'PUB', name: 'Pueblo Memorial Airport', city: 'Pueblo CO', country: 'US', lat: 38.29, lon: -104.5, population: 0.1, tier: 'regional' },
  { code: 'SGF', name: 'Springfield-Branson Natl', city: 'Springfield MO', country: 'US', lat: 37.25, lon: -93.39, population: 0.5, tier: 'regional' },
  { code: 'SJT', name: 'Mathis Field', city: 'San Angelo', country: 'US', lat: 31.36, lon: -100.5, population: 0.1, tier: 'regional' },
  { code: 'TXK', name: 'Texarkana Regional', city: 'Texarkana', country: 'US', lat: 33.45, lon: -93.99, population: 0.1, tier: 'regional' },
  { code: 'TYR', name: 'Tyler Pounds Regional', city: 'Tyler TX', country: 'US', lat: 32.35, lon: -95.4, population: 0.2, tier: 'regional' },
  { code: 'VLD', name: 'Valdosta Regional', city: 'Valdosta', country: 'US', lat: 30.78, lon: -83.28, population: 0.1, tier: 'regional' },
  { code: 'VPS', name: 'Destin-Fort Walton Beach', city: 'Fort Walton Beach', country: 'US', lat: 30.48, lon: -86.52, population: 0.3, tier: 'regional' },
  { code: 'WRG', name: 'Wrangell Airport', city: 'Wrangell', country: 'US', lat: 56.48, lon: -132.37, population: 0.003, tier: 'regional' },
  { code: 'YQQ', name: 'CFB Comox', city: 'Comox', country: 'CA', lat: 49.71, lon: -124.88, population: 0.07, tier: 'regional' },
  { code: 'YBR', name: 'Brandon Municipal Airport', city: 'Brandon MB', country: 'CA', lat: 49.91, lon: -99.95, population: 0.05, tier: 'regional' },
  { code: 'YPR', name: 'Prince Rupert Airport', city: 'Prince Rupert', country: 'CA', lat: 54.29, lon: -130.44, population: 0.02, tier: 'regional' },
  { code: 'YXJ', name: 'Fort St. John Airport', city: 'Fort St. John', country: 'CA', lat: 56.24, lon: -120.74, population: 0.03, tier: 'regional' },
  { code: 'YKF', name: 'Region of Waterloo Intl', city: 'Waterloo ON', country: 'CA', lat: 43.46, lon: -80.38, population: 0.6, tier: 'regional' },
  { code: 'ITO', name: 'Hilo Intl', city: 'Hilo', country: 'US', lat: 19.72, lon: -155.05, population: 0.05, tier: 'regional' },
  { code: 'LIH', name: 'Lihue Airport', city: 'Lihue', country: 'US', lat: 21.98, lon: -159.34, population: 0.08, tier: 'regional' },
  { code: 'PDL', name: 'Ponta Delgada Airport', city: 'Ponta Delgada', country: 'PT', lat: 37.74, lon: -25.7, population: 0.06, tier: 'regional' },
  { code: 'GNB', name: 'Grenoble-Isere Airport', city: 'Grenoble', country: 'FR', lat: 45.36, lon: 5.33, population: 0.7, tier: 'regional' },
  { code: 'CMF', name: 'Chambery-Savoie Airport', city: 'Chambery', country: 'FR', lat: 45.64, lon: 5.88, population: 0.2, tier: 'regional' },
  { code: 'MPL', name: 'Montpellier Mediterranean', city: 'Montpellier', country: 'FR', lat: 43.58, lon: 3.96, population: 0.6, tier: 'regional' },
  { code: 'ETZ', name: 'Metz-Nancy-Lorraine Airport', city: 'Metz', country: 'FR', lat: 48.98, lon: 6.25, population: 0.5, tier: 'regional' },
  { code: 'RNS', name: 'Rennes-Saint-Jacques Airport', city: 'Rennes', country: 'FR', lat: 48.07, lon: -1.73, population: 0.7, tier: 'regional' },
  { code: 'CFE', name: 'Clermont-Ferrand Auvergne', city: 'Clermont-Ferrand', country: 'FR', lat: 45.79, lon: 3.17, population: 0.3, tier: 'regional' },
  { code: 'YGK', name: 'Kingston Norman Rogers', city: 'Kingston ON', country: 'CA', lat: 44.22, lon: -76.6, population: 0.17, tier: 'regional' },
  { code: 'BIQ', name: 'Biarritz Pays Basque Airport', city: 'Biarritz', country: 'FR', lat: 43.47, lon: -1.53, population: 0.2, tier: 'regional' },
  { code: 'LRH', name: 'La Rochelle-Ile de Re Airport', city: 'La Rochelle', country: 'FR', lat: 46.18, lon: -1.2, population: 0.2, tier: 'regional' },
  { code: 'TUF', name: 'Tours Val de Loire Airport', city: 'Tours', country: 'FR', lat: 47.43, lon: 0.73, population: 0.3, tier: 'regional' },
  { code: 'MXN', name: 'Morlaix-Ploujean Airport', city: 'Morlaix', country: 'FR', lat: 48.6, lon: -3.82, population: 0.06, tier: 'regional' },
  { code: 'VLL', name: 'Valladolid Airport', city: 'Valladolid', country: 'ES', lat: 41.71, lon: -4.85, population: 0.3, tier: 'regional' },
  { code: 'ZAZ', name: 'Zaragoza Airport', city: 'Zaragoza', country: 'ES', lat: 41.66, lon: -1.04, population: 0.7, tier: 'regional' },
  { code: 'OVD', name: 'Asturias Airport', city: 'Oviedo', country: 'ES', lat: 43.56, lon: -6.03, population: 0.4, tier: 'regional' },
  { code: 'LEN', name: 'Leon Airport', city: 'Leon', country: 'ES', lat: 42.59, lon: -5.66, population: 0.1, tier: 'regional' },
  { code: 'REU', name: 'Reus Airport', city: 'Reus', country: 'ES', lat: 41.15, lon: 1.17, population: 0.1, tier: 'regional' },
  { code: 'MJV', name: 'Murcia-San Javier Airport', city: 'Murcia', country: 'ES', lat: 37.78, lon: -0.81, population: 0.5, tier: 'regional' },
  { code: 'GRX', name: 'Federico Garcia Lorca Airport', city: 'Granada', country: 'ES', lat: 37.19, lon: -3.78, population: 0.2, tier: 'regional' },
  { code: 'LEI', name: 'Almeria Airport', city: 'Almeria', country: 'ES', lat: 36.85, lon: -2.37, population: 0.2, tier: 'regional' },
  { code: 'XRY', name: 'Jerez Airport', city: 'Jerez', country: 'ES', lat: 36.74, lon: -6.06, population: 0.2, tier: 'regional' },
  { code: 'CIY', name: 'Comiso Airport', city: 'Comiso', country: 'IT', lat: 36.99, lon: 14.61, population: 0.05, tier: 'regional' },
  { code: 'PMF', name: 'Parma Giuseppe Verdi', city: 'Parma', country: 'IT', lat: 44.82, lon: 10.3, population: 0.4, tier: 'regional' },
  { code: 'BGY', name: 'Bergamo Orio al Serio Airport', city: 'Bergamo', country: 'IT', lat: 45.67, lon: 9.7, population: 1.1, tier: 'regional' },
  { code: 'BRI', name: 'Bari Karol Wojtyla Airport', city: 'Bari', country: 'IT', lat: 41.14, lon: 16.76, population: 1.3, tier: 'regional' },
  { code: 'GOA', name: 'Cristoforo Colombo Intl', city: 'Genoa', country: 'IT', lat: 44.41, lon: 8.84, population: 0.8, tier: 'regional' },
  { code: 'BSL', name: 'EuroAirport Basel-Mulhouse', city: 'Basel', country: 'CH', lat: 47.6, lon: 7.53, population: 0.6, tier: 'regional' },
  { code: 'BRN', name: 'Bern Airport', city: 'Bern', country: 'CH', lat: 46.91, lon: 7.5, population: 0.4, tier: 'regional' },
  { code: 'ABR', name: 'Aberdeen Regional', city: 'Aberdeen SD', country: 'US', lat: 45.45, lon: -98.42, population: 0.03, tier: 'regional' },
  { code: 'ADK', name: 'Adak Airport', city: 'Adak', country: 'US', lat: 51.88, lon: -176.64, population: 0.003, tier: 'regional' },
  { code: 'BTM', name: 'Bert Mooney Airport', city: 'Butte MT', country: 'US', lat: 45.95, lon: -112.5, population: 0.04, tier: 'regional' },
  { code: 'CDV', name: 'Merle K Smith Airport', city: 'Cordova AK', country: 'US', lat: 60.49, lon: -145.48, population: 0.003, tier: 'regional' },
  { code: 'CLD', name: 'McClellan-Palomar Airport', city: 'Carlsbad CA', country: 'US', lat: 33.13, lon: -117.28, population: 0.9, tier: 'regional' },
  { code: 'CNY', name: 'Moab Regional Airport', city: 'Moab UT', country: 'US', lat: 38.76, lon: -109.75, population: 0.01, tier: 'regional' },
  { code: 'COD', name: 'Yellowstone Regional', city: 'Cody WY', country: 'US', lat: 44.52, lon: -109.02, population: 0.01, tier: 'regional' },
  { code: 'DIK', name: 'Dickinson Theodore Roosevelt', city: 'Dickinson ND', country: 'US', lat: 46.8, lon: -102.8, population: 0.03, tier: 'regional' },
  { code: 'DVN', name: 'Quad City Intl', city: 'Davenport IA', country: 'US', lat: 41.61, lon: -90.58, population: 0.4, tier: 'regional' },
  { code: 'EGE', name: 'Eagle County Regional', city: 'Eagle CO', country: 'US', lat: 39.64, lon: -106.92, population: 0.06, tier: 'regional' },
  { code: 'ERI', name: 'Erie Intl', city: 'Erie PA', country: 'US', lat: 42.08, lon: -80.18, population: 0.3, tier: 'regional' },
  { code: 'ESC', name: 'Delta County Airport', city: 'Escanaba MI', country: 'US', lat: 45.72, lon: -87.09, population: 0.03, tier: 'regional' },
  { code: 'EWN', name: 'Coastal Carolina Regional', city: 'New Bern NC', country: 'US', lat: 35.07, lon: -77.04, population: 0.1, tier: 'regional' },
  { code: 'GTU', name: 'Georgetown Municipal', city: 'Georgetown TX', country: 'US', lat: 30.68, lon: -97.68, population: 0.08, tier: 'regional' },
  { code: 'HOM', name: 'Homer Airport', city: 'Homer AK', country: 'US', lat: 59.65, lon: -151.48, population: 0.01, tier: 'regional' },
  { code: 'HSP', name: 'Ingalls Field', city: 'Hot Springs VA', country: 'US', lat: 38.26, lon: -79.83, population: 0.01, tier: 'regional' },
  { code: 'HVR', name: 'Havre City-County Airport', city: 'Havre MT', country: 'US', lat: 48.54, lon: -109.76, population: 0.01, tier: 'regional' },
  { code: 'IMT', name: 'Ford Airport', city: 'Iron Mountain MI', country: 'US', lat: 45.82, lon: -88.11, population: 0.03, tier: 'regional' },
  { code: 'INL', name: 'Falls Intl', city: 'International Falls MN', country: 'US', lat: 48.57, lon: -93.4, population: 0.01, tier: 'regional' },
  { code: 'ISN', name: 'Sloulin Field Intl', city: 'Williston ND', country: 'US', lat: 48.18, lon: -103.64, population: 0.05, tier: 'regional' },
  { code: 'IYK', name: 'Inyokern Airport', city: 'Inyokern CA', country: 'US', lat: 35.66, lon: -117.83, population: 0.01, tier: 'regional' },
  { code: 'JMS', name: 'Jamestown Regional', city: 'Jamestown ND', country: 'US', lat: 46.93, lon: -98.68, population: 0.02, tier: 'regional' },
  { code: 'LAM', name: 'Los Alamos Airport', city: 'Los Alamos NM', country: 'US', lat: 35.88, lon: -106.27, population: 0.02, tier: 'regional' },
  { code: 'MHK', name: 'Manhattan Regional', city: 'Manhattan KS', country: 'US', lat: 39.14, lon: -96.67, population: 0.07, tier: 'regional' },
  { code: 'MLS', name: 'Frank Wiley Field', city: 'Miles City MT', country: 'US', lat: 46.43, lon: -105.89, population: 0.01, tier: 'regional' },
  { code: 'MSO', name: 'Missoula Montana Airport', city: 'Missoula', country: 'US', lat: 46.92, lon: -114.09, population: 0.1, tier: 'regional' },
  { code: 'MTO', name: 'Coles County Memorial', city: 'Mattoon IL', country: 'US', lat: 39.48, lon: -88.28, population: 0.03, tier: 'regional' },
  { code: 'OGD', name: 'Ogden-Hinckley Airport', city: 'Ogden UT', country: 'US', lat: 41.2, lon: -112.01, population: 0.8, tier: 'regional' },
  { code: 'OME', name: 'Nome Airport', city: 'Nome AK', country: 'US', lat: 64.51, lon: -165.44, population: 0.003, tier: 'regional' },
  { code: 'PAH', name: 'Barkley Regional Airport', city: 'Paducah KY', country: 'US', lat: 37.06, lon: -88.77, population: 0.1, tier: 'regional' },
  { code: 'PGA', name: 'Page Municipal Airport', city: 'Page AZ', country: 'US', lat: 36.93, lon: -111.45, population: 0.01, tier: 'regional' },
  { code: 'PIR', name: 'Pierre Regional Airport', city: 'Pierre SD', country: 'US', lat: 44.38, lon: -100.28, population: 0.02, tier: 'regional' },
  { code: 'PRC', name: 'Prescott Regional Airport', city: 'Prescott AZ', country: 'US', lat: 34.65, lon: -112.42, population: 0.1, tier: 'regional' },
  { code: 'PSC', name: 'Tri-Cities Airport', city: 'Pasco WA', country: 'US', lat: 46.26, lon: -119.12, population: 0.3, tier: 'regional' },
  { code: 'RDM', name: 'Roberts Field', city: 'Redmond OR', country: 'US', lat: 44.25, lon: -121.15, population: 0.2, tier: 'regional' },
  { code: 'RKS', name: 'Southwest Wyoming Regional', city: 'Rock Springs WY', country: 'US', lat: 41.6, lon: -109.07, population: 0.03, tier: 'regional' },
  { code: 'SCE', name: 'University Park Airport', city: 'State College PA', country: 'US', lat: 40.85, lon: -77.85, population: 0.1, tier: 'regional' },
  { code: 'SIT', name: 'Sitka Rocky Gutierrez Airport', city: 'Sitka AK', country: 'US', lat: 57.05, lon: -135.36, population: 0.01, tier: 'regional' },
  { code: 'SLN', name: 'Salina Regional Airport', city: 'Salina KS', country: 'US', lat: 38.79, lon: -97.65, population: 0.05, tier: 'regional' },
  { code: 'SMX', name: 'Santa Maria Airport', city: 'Santa Maria CA', country: 'US', lat: 34.9, lon: -120.46, population: 0.2, tier: 'regional' },
  { code: 'STC', name: 'St Cloud Regional Airport', city: 'St Cloud MN', country: 'US', lat: 45.54, lon: -94.06, population: 0.1, tier: 'regional' },
  { code: 'TEX', name: 'Telluride Regional Airport', city: 'Telluride CO', country: 'US', lat: 37.95, lon: -107.9, population: 0.02, tier: 'regional' },
  { code: 'TWF', name: 'Magic Valley Regional', city: 'Twin Falls ID', country: 'US', lat: 42.48, lon: -114.49, population: 0.08, tier: 'regional' },
  { code: 'VEL', name: 'Vernal Regional Airport', city: 'Vernal UT', country: 'US', lat: 40.44, lon: -109.51, population: 0.01, tier: 'regional' },
  { code: 'WYS', name: 'Yellowstone Airport', city: 'West Yellowstone MT', country: 'US', lat: 44.69, lon: -111.12, population: 0.01, tier: 'regional' },
  { code: 'YUM', name: 'Yuma Intl Airport', city: 'Yuma AZ', country: 'US', lat: 32.66, lon: -114.61, population: 0.1, tier: 'regional' },
  { code: 'ANU', name: 'V.C. Bird Intl', city: 'St. Johns Antigua', country: 'AG', lat: 17.14, lon: -61.79, population: 0.1, tier: 'regional' },
  { code: 'GND', name: 'Maurice Bishop Intl', city: 'St. George Grenada', country: 'GD', lat: 12.0, lon: -61.79, population: 0.1, tier: 'regional' },
  { code: 'SKB', name: 'Robert Llewellyn Bradshaw Intl', city: 'Basseterre', country: 'KN', lat: 17.31, lon: -62.72, population: 0.05, tier: 'regional' },
  { code: 'SXB', name: 'Strasbourg Airport', city: 'Strasbourg', country: 'FR', lat: 48.54, lon: 7.63, population: 0.5, tier: 'regional' },
  { code: 'LIG', name: 'Limoges Airport', city: 'Limoges', country: 'FR', lat: 45.86, lon: 1.18, population: 0.2, tier: 'regional' },
  { code: 'PGF', name: 'Perpignan Airport', city: 'Perpignan', country: 'FR', lat: 42.74, lon: 2.87, population: 0.3, tier: 'regional' },
  { code: 'FSC', name: 'Figari Sud Corse Airport', city: 'Figari', country: 'FR', lat: 41.5, lon: 9.1, population: 0.05, tier: 'regional' },
  { code: 'KLU', name: 'Klagenfurt Airport', city: 'Klagenfurt', country: 'AT', lat: 46.64, lon: 14.34, population: 0.1, tier: 'regional' },
  { code: 'WIC', name: 'Wick Airport', city: 'Wick', country: 'GB', lat: 58.46, lon: -3.09, population: 0.01, tier: 'regional' },
  { code: 'LSI', name: 'Sumburgh Airport', city: 'Lerwick Shetland', country: 'GB', lat: 59.88, lon: -1.3, population: 0.02, tier: 'regional' },
  { code: 'KOI', name: 'Kirkwall Airport', city: 'Kirkwall Orkney', country: 'GB', lat: 58.96, lon: -2.9, population: 0.02, tier: 'regional' },
  { code: 'IOM', name: 'Isle of Man Airport', city: 'Castletown', country: 'IM', lat: 54.08, lon: -4.62, population: 0.08, tier: 'regional' },

  // ── EXPANSION: scored additions (tools/airport-expansion) ────────────────────
  // Passed both gates (distinct >=90km from existing, viable >=150 pax/wk) on the
  // game's own gravity model. See tools/airport-expansion/scored-candidates.csv.
  // East Asia (Chinese secondary metros)
  { code: 'NTG', name: 'Nantong Xingdong',         city: 'Nantong',        country: 'CN', lat: 32.07, lon: 120.98, population: 7.7, tier: 'regional' },
  { code: 'WUX', name: 'Sunan Shuofang Intl',      city: 'Wuxi',           country: 'CN', lat: 31.49, lon: 120.43, population: 7.5, tier: 'regional' },
  { code: 'ZHA', name: 'Zhanjiang Wuchuan',        city: 'Zhanjiang',      country: 'CN', lat: 21.21, lon: 110.36, population: 7.0, tier: 'major'    },
  { code: 'SWA', name: 'Jieyang Chaoshan Intl',    city: 'Shantou',        country: 'CN', lat: 23.55, lon: 116.50, population: 5.6, tier: 'major'    },
  { code: 'DYG', name: 'Zhangjiajie Hehua Intl',   city: 'Zhangjiajie',    country: 'CN', lat: 29.10, lon: 110.44, population: 1.5, tier: 'regional' },
  { code: 'JHG', name: 'Xishuangbanna Gasa',       city: 'Jinghong',       country: 'CN', lat: 21.97, lon: 100.76, population: 1.3, tier: 'regional' },
  // South & Southeast Asia
  { code: 'UDR', name: 'Maharana Pratap',          city: 'Udaipur',        country: 'IN', lat: 24.62, lon: 73.90,  population: 0.9, tier: 'regional' },
  { code: 'URT', name: 'Surat Thani Intl',         city: 'Surat Thani',    country: 'TH', lat: 9.13,  lon: 99.14,  population: 1.0, tier: 'regional' },
  { code: 'CXR', name: 'Cam Ranh Intl',            city: 'Nha Trang',      country: 'VN', lat: 11.99, lon: 109.22, population: 0.5, tier: 'regional' },
  { code: 'LPQ', name: 'Luang Prabang Intl',       city: 'Luang Prabang',  country: 'LA', lat: 19.90, lon: 102.16, population: 0.1, tier: 'regional' },
  { code: 'CGY', name: 'Laguindingan',             city: 'Cagayan de Oro', country: 'PH', lat: 8.61,  lon: 124.46, population: 0.9, tier: 'regional' },
  // Indonesia (archipelago)
  { code: 'BDO', name: 'Husein Sastranegara',      city: 'Bandung',        country: 'ID', lat: -6.90, lon: 107.58, population: 8.5, tier: 'major'    },
  { code: 'PNK', name: 'Supadio',                  city: 'Pontianak',      country: 'ID', lat: -0.15, lon: 109.40, population: 1.0, tier: 'regional' },
  { code: 'KOE', name: 'El Tari',                  city: 'Kupang',         country: 'ID', lat: -10.17,lon: 123.67, population: 0.5, tier: 'regional' },
  { code: 'AMQ', name: 'Pattimura',                city: 'Ambon',          country: 'ID', lat: -3.71, lon: 128.09, population: 0.4, tier: 'regional' },
  { code: 'DJJ', name: 'Sentani',                  city: 'Jayapura',       country: 'ID', lat: -2.58, lon: 140.52, population: 0.4, tier: 'regional' },
  // Middle East / Central Asia / Caribbean
  { code: 'RAK', name: 'Marrakesh Menara',         city: 'Marrakesh',      country: 'MA', lat: 31.61, lon: -8.04,  population: 1.5, tier: 'regional' },
  { code: 'SKD', name: 'Samarkand Intl',           city: 'Samarkand',      country: 'UZ', lat: 39.70, lon: 66.98,  population: 0.6, tier: 'regional' },
  { code: 'AUA', name: 'Queen Beatrix Intl',       city: 'Oranjestad',     country: 'AW', lat: 12.50, lon: -70.01, population: 0.1, tier: 'regional', visitors: 1.1 },

  // ── EXPANSION: iconic / novelty ──────────────────────────────────────────────
  { code: 'DIL', name: 'Pres. Nicolau Lobato Intl', city: 'Dili', country: 'TL', lat: -8.55, lon: 125.53, population: 0.28, tier: 'regional' },
  { code: 'PBH', name: 'Paro Intl', city: 'Paro', country: 'BT', lat: 27.4, lon: 89.42, population: 0.1, tier: 'regional', visitors: 0.3, gateway: 0.5 },
  { code: 'USH', name: 'Malvinas Argentinas', city: 'Ushuaia', country: 'AR', lat: -54.84, lon: -68.3, population: 0.08, tier: 'regional' },
  { code: 'FAE', name: 'Vagar', city: 'Sorvagur', country: 'FO', lat: 62.06, lon: -7.27, population: 0.05, tier: 'regional' },
  { code: 'GOH', name: 'Nuuk Intl', city: 'Nuuk', country: 'GL', lat: 64.19, lon: -51.68, population: 0.019, tier: 'regional' },
  { code: 'DCY', name: 'Daocheng Yading', city: 'Daocheng', country: 'CN', lat: 29.32, lon: 100.05, population: 0.03, tier: 'regional' },
  { code: 'BPX', name: 'Qamdo Bamda', city: 'Qamdo', country: 'CN', lat: 30.55, lon: 97.11, population: 0.06, tier: 'regional' },
  { code: 'LUA', name: 'Tenzing-Hillary', city: 'Lukla', country: 'NP', lat: 27.69, lon: 86.73, population: 0.005, tier: 'regional' },
  { code: 'HGU', name: 'Mount Hagen Kagamuga', city: 'Mount Hagen', country: 'PG', lat: -5.83, lon: 144.3, population: 0.03, tier: 'regional' },
  { code: 'PPG', name: 'Pago Pago Intl', city: 'Pago Pago', country: 'AS', lat: -14.33, lon: -170.71, population: 0.05, tier: 'regional' },
  { code: 'IPC', name: 'Mataveri', city: 'Easter Island', country: 'CL', lat: -27.16, lon: -109.42, population: 0.008, tier: 'regional', visitors: 0.1 },
  { code: 'INU', name: 'Nauru Intl', city: 'Yaren', country: 'NR', lat: -0.55, lon: 166.92, population: 0.01, tier: 'regional' },
  { code: 'GIS', name: 'Gisborne', city: 'Gisborne', country: 'NZ', lat: -38.66, lon: 177.98, population: 0.05, tier: 'regional' },
  { code: 'FSP', name: 'St-Pierre Pointe Blanche', city: 'St-Pierre', country: 'PM', lat: 46.76, lon: -56.17, population: 0.006, tier: 'regional' },
  { code: 'MNK', name: 'Maumere Frans Seda', city: 'Maumere', country: 'ID', lat: -8.64, lon: 122.24, population: 0.07, tier: 'regional' },
  { code: 'BRR', name: 'Barra', city: 'Barra', country: 'GB', lat: 57.02, lon: -7.44, population: 0.001, tier: 'regional' },
  { code: 'LYR', name: 'Svalbard Longyear', city: 'Longyearbyen', country: 'NO', lat: 78.25, lon: 15.46, population: 0.002, tier: 'regional' },
  { code: 'HLE', name: 'St Helena', city: 'Jamestown', country: 'SH', lat: -15.96, lon: -5.65, population: 0.004, tier: 'regional' },
  { code: 'SAB', name: 'Juancho Yrausquin', city: 'Saba', country: 'BQ', lat: 17.64, lon: -63.22, population: 0.002, tier: 'regional' },
  { code: 'SBH', name: 'Gustaf III', city: 'Gustavia', country: 'BL', lat: 17.9, lon: -62.84, population: 0.01, tier: 'regional' },
  { code: 'GIB', name: 'Gibraltar Intl', city: 'Gibraltar', country: 'GI', lat: 36.15, lon: -5.35, population: 0.03, tier: 'regional' },
  { code: 'CVF', name: 'Courchevel Altiport', city: 'Courchevel', country: 'FR', lat: 45.4, lon: 6.63, population: 0.002, tier: 'regional' },
  { code: 'SFJ', name: 'Kangerlussuaq', city: 'Kangerlussuaq', country: 'GL', lat: 67.01, lon: -50.71, population: 0.001, tier: 'regional' },
  { code: 'NLK', name: 'Norfolk Island', city: 'Burnt Pine', country: 'NF', lat: -29.04, lon: 167.94, population: 0.002, tier: 'regional' },
  { code: 'AXA', name: 'Clayton J Lloyd', city: 'The Valley', country: 'AI', lat: 18.2, lon: -63.06, population: 0.01, tier: 'regional' },
  { code: 'VQS', name: 'Antonio Rivera', city: 'Vieques', country: 'US', lat: 18.13, lon: -65.49, population: 0.009, tier: 'regional' },
  { code: 'SDU', name: 'Santos Dumont', city: 'Rio de Janeiro', country: 'BR', lat: -22.91, lon: -43.16, population: 13.6, tier: 'regional' },
  // ── EXPANSION: UN member coverage (primary intl airport) ─────────────────────
  { code: 'BJM', name: 'Bujumbura Intl', city: 'Bujumbura', country: 'BI', lat: -3.32, lon: 29.32, population: 1.1, tier: 'regional' },
  { code: 'HAH', name: 'Prince Said Ibrahim', city: 'Moroni', country: 'KM', lat: -11.53, lon: 43.27, population: 0.7, tier: 'regional' },
  { code: 'DOM', name: 'Douglas-Charles', city: 'Marigot', country: 'DM', lat: 15.55, lon: -61.3, population: 0.07, tier: 'regional' },
  { code: 'SSG', name: 'Malabo Intl', city: 'Malabo', country: 'GQ', lat: 3.76, lon: 8.71, population: 0.3, tier: 'regional' },
  { code: 'SHO', name: 'King Mswati III', city: 'Manzini', country: 'SZ', lat: -26.36, lon: 31.72, population: 0.4, tier: 'regional' },
  { code: 'CKY', name: 'Conakry Intl', city: 'Conakry', country: 'GN', lat: 9.58, lon: -13.61, population: 2, tier: 'regional' },
  { code: 'PAP', name: 'Toussaint Louverture', city: 'Port-au-Prince', country: 'HT', lat: 18.58, lon: -72.29, population: 2.8, tier: 'regional' },
  { code: 'FNJ', name: 'Pyongyang Sunan Intl', city: 'Pyongyang', country: 'KP', lat: 39.22, lon: 125.67, population: 3, tier: 'regional' },
  { code: 'MSU', name: 'Moshoeshoe I Intl', city: 'Maseru', country: 'LS', lat: -29.46, lon: 27.55, population: 0.4, tier: 'regional' },
  { code: 'ROB', name: 'Roberts Intl', city: 'Monrovia', country: 'LR', lat: 6.23, lon: -10.36, population: 1.6, tier: 'regional' },
  { code: 'MLE', name: 'Velana Intl', city: 'Male', country: 'MV', lat: 4.19, lon: 73.53, population: 0.4, tier: 'major', visitors: 1.8 },
  { code: 'MAJ', name: 'Marshall Islands Intl', city: 'Majuro', country: 'MH', lat: 7.06, lon: 171.27, population: 0.03, tier: 'regional' },
  { code: 'PNI', name: 'Pohnpei Intl', city: 'Kolonia', country: 'FM', lat: 6.99, lon: 158.21, population: 0.04, tier: 'regional' },
  { code: 'ULN', name: 'Chinggis Khaan Intl', city: 'Ulaanbaatar', country: 'MN', lat: 47.84, lon: 106.77, population: 1.6, tier: 'major', gateway: 1.6 },
  { code: 'ROR', name: 'Roman Tmetuchl Intl', city: 'Koror', country: 'PW', lat: 7.37, lon: 134.54, population: 0.02, tier: 'regional' },
  { code: 'UVF', name: 'Hewanorra Intl', city: 'Vieux Fort', country: 'LC', lat: 13.73, lon: -60.95, population: 0.18, tier: 'regional' },
  { code: 'SVD', name: 'Argyle Intl', city: 'Kingstown', country: 'VC', lat: 13.16, lon: -61.15, population: 0.11, tier: 'regional' },
  { code: 'FNA', name: 'Lungi Intl', city: 'Freetown', country: 'SL', lat: 8.62, lon: -13.2, population: 1.3, tier: 'regional' },
  { code: 'JUB', name: 'Juba Intl', city: 'Juba', country: 'SS', lat: 4.87, lon: 31.6, population: 0.5, tier: 'regional' },
  { code: 'DAM', name: 'Damascus Intl', city: 'Damascus', country: 'SY', lat: 33.41, lon: 36.51, population: 2.5, tier: 'regional' },
  { code: 'FUN', name: 'Funafuti Intl', city: 'Funafuti', country: 'TV', lat: -8.52, lon: 179.2, population: 0.006, tier: 'regional' },

  // ── EXPANSION: 1500 build (traffic-share allocation; tools/airport-expansion) ──
  { code: 'XUZ', name: 'Xuzhou Guanyin', city: 'Xuzhou', country: 'CN', lat: 34.06, lon: 117.56, population: 9, tier: 'major' },
  { code: 'WEF', name: 'Weifang Nanyuan', city: 'Weifang', country: 'CN', lat: 36.65, lon: 119.12, population: 9.4, tier: 'major' },
  { code: 'YNZ', name: 'Yancheng Nanyang', city: 'Yancheng', country: 'CN', lat: 33.43, lon: 120.2, population: 7.2, tier: 'regional' },
  { code: 'NNY', name: 'Nanyang Jiangying', city: 'Nanyang', country: 'CN', lat: 32.98, lon: 112.61, population: 9.7, tier: 'major' },
  { code: 'FUG', name: 'Fuyang Xiguan', city: 'Fuyang', country: 'CN', lat: 32.88, lon: 115.73, population: 8.2, tier: 'major' },
  { code: 'HYN', name: 'Taizhou Luqiao', city: 'Taizhou', country: 'CN', lat: 28.56, lon: 121.43, population: 6.6, tier: 'regional' },
  { code: 'HDG', name: 'Handan', city: 'Handan', country: 'CN', lat: 36.52, lon: 114.43, population: 9.4, tier: 'major' },
  { code: 'JNG', name: 'Jining Da\'an', city: 'Jining', country: 'CN', lat: 35.29, lon: 116.35, population: 8, tier: 'major' },
  { code: 'KOW', name: 'Ganzhou Huangjin', city: 'Ganzhou', country: 'CN', lat: 25.85, lon: 114.78, population: 8.9, tier: 'major' },
  { code: 'HUZ', name: 'Huizhou Pingtan', city: 'Huizhou', country: 'CN', lat: 23.05, lon: 114.6, population: 6, tier: 'regional' },
  { code: 'JOG', name: 'Yogyakarta Intl', city: 'Yogyakarta', country: 'ID', lat: -7.9, lon: 110.05, population: 4, tier: 'regional', visitors: 2 },
  { code: 'YTY', name: 'Yangzhou Taizhou', city: 'Yangzhou', country: 'CN', lat: 32.56, lon: 119.72, population: 4.5, tier: 'regional' },
  { code: 'HIA', name: 'Huai\'an Lianshui', city: 'Huai\'an', country: 'CN', lat: 33.79, lon: 119.13, population: 4.6, tier: 'regional' },
  { code: 'LYI', name: 'Linyi Qiyang', city: 'Linyi', country: 'CN', lat: 35.05, lon: 118.41, population: 5, tier: 'regional' },
  { code: 'LYG', name: 'Lianyungang Baitabu', city: 'Lianyungang', country: 'CN', lat: 34.57, lon: 119.25, population: 4.6, tier: 'regional' },
  { code: 'KWL', name: 'Guilin Liangjiang', city: 'Guilin', country: 'CN', lat: 25.22, lon: 110.04, population: 5, tier: 'regional', visitors: 1.5 },
  { code: 'XFN', name: 'Xiangyang Liuji', city: 'Xiangyang', country: 'CN', lat: 32.15, lon: 112.29, population: 5.3, tier: 'regional' },
  { code: 'CGD', name: 'Changde Taohuayuan', city: 'Changde', country: 'CN', lat: 28.92, lon: 111.64, population: 5.3, tier: 'regional' },
  { code: 'BFJ', name: 'Bijie Feixiong', city: 'Bijie', country: 'CN', lat: 27.27, lon: 105.47, population: 6.9, tier: 'regional' },
  { code: 'LYP', name: 'Faisalabad Intl', city: 'Faisalabad', country: 'PK', lat: 31.36, lon: 72.99, population: 3.6, tier: 'regional' },
  { code: 'NDG', name: 'Qiqihar Sanjiazi', city: 'Qiqihar', country: 'CN', lat: 47.24, lon: 123.92, population: 5.3, tier: 'regional' },
  { code: 'JGS', name: 'Ji\'an Jinggangshan', city: 'Ji\'an', country: 'CN', lat: 26.86, lon: 114.74, population: 4.5, tier: 'regional' },
  { code: 'CDE', name: 'Chengde Puning', city: 'Chengde', country: 'CN', lat: 40.94, lon: 118.07, population: 3.4, tier: 'regional', visitors: 1 },
  { code: 'CGQ', name: 'Changchun Longjia', city: 'Changchun', country: 'CN', lat: 43.99, lon: 125.68, population: 4.5, tier: 'regional' },
  { code: 'CIF', name: 'Chifeng Yulong', city: 'Chifeng', country: 'CN', lat: 42.24, lon: 118.91, population: 4.3, tier: 'regional' },
  { code: 'YCU', name: 'Yuncheng Zhangxiao', city: 'Yuncheng', country: 'CN', lat: 35.12, lon: 111.03, population: 4.8, tier: 'regional' },
  { code: 'BFU', name: 'Bengbu', city: 'Bengbu', country: 'CN', lat: 32.85, lon: 117.32, population: 3.3, tier: 'regional' },
  { code: 'DAX', name: 'Dazhou Heshi', city: 'Dazhou', country: 'CN', lat: 31.13, lon: 107.43, population: 5.4, tier: 'regional' },
  { code: 'BPE', name: 'Qinhuangdao Beidaihe', city: 'Qinhuangdao', country: 'CN', lat: 39.67, lon: 119.06, population: 3.1, tier: 'regional', visitors: 0.8 },
  { code: 'NAO', name: 'Nanchong Gaoping', city: 'Nanchong', country: 'CN', lat: 30.79, lon: 106.16, population: 5.6, tier: 'regional' },
  { code: 'MXZ', name: 'Meixian', city: 'Meizhou', country: 'CN', lat: 24.35, lon: 116.13, population: 4, tier: 'regional' },
  { code: 'LFQ', name: 'Linfen Qiaoli', city: 'Linfen', country: 'CN', lat: 36.13, lon: 111.64, population: 4.3, tier: 'regional' },
  { code: 'HJJ', name: 'Huaihua Zhijiang', city: 'Huaihua', country: 'CN', lat: 27.44, lon: 109.7, population: 4.6, tier: 'regional' },
  { code: 'YIH', name: 'Yichang Sanxia', city: 'Yichang', country: 'CN', lat: 30.56, lon: 111.48, population: 4, tier: 'regional' },
  { code: 'LZH', name: 'Liuzhou Bailian', city: 'Liuzhou', country: 'CN', lat: 24.21, lon: 109.39, population: 4.2, tier: 'regional' },
  { code: 'JIL', name: 'Jilin Ertaizi', city: 'Jilin', country: 'CN', lat: 44, lon: 126.4, population: 3.6, tier: 'regional' },
  { code: 'RIZ', name: 'Rizhao Shanzihe', city: 'Rizhao', country: 'CN', lat: 35.4, lon: 119.32, population: 3, tier: 'regional' },
  { code: 'DAT', name: 'Datong Yungang', city: 'Datong', country: 'CN', lat: 40.06, lon: 113.48, population: 3.4, tier: 'regional' },
  { code: 'ZAT', name: 'Zhaotong', city: 'Zhaotong', country: 'CN', lat: 27.32, lon: 103.75, population: 5.3, tier: 'regional' },
  { code: 'HET', name: 'Hohhot Baita', city: 'Hohhot', country: 'CN', lat: 40.85, lon: 111.82, population: 3.4, tier: 'regional' },
  { code: 'JUZ', name: 'Quzhou', city: 'Quzhou', country: 'CN', lat: 28.97, lon: 118.9, population: 2.3, tier: 'regional' },
  { code: 'UYN', name: 'Yulin Yuyang', city: 'Yulin', country: 'CN', lat: 38.27, lon: 109.59, population: 3.6, tier: 'regional' },
  { code: 'YBP', name: 'Yibin Wuliangye', city: 'Yibin', country: 'CN', lat: 28.86, lon: 104.53, population: 4.6, tier: 'regional' },
  { code: 'CIH', name: 'Changzhi Wangcun', city: 'Changzhi', country: 'CN', lat: 36.25, lon: 113.13, population: 3.2, tier: 'regional' },
  { code: 'LZO', name: 'Luzhou Yunlong', city: 'Luzhou', country: 'CN', lat: 28.85, lon: 105.4, population: 4.3, tier: 'regional' },
  { code: 'WUZ', name: 'Wuzhou Xijiang', city: 'Wuzhou', country: 'CN', lat: 23.4, lon: 111.25, population: 2.8, tier: 'regional' },
  { code: 'LCX', name: 'Longyan Guanzhishan', city: 'Longyan', country: 'CN', lat: 25.67, lon: 116.75, population: 2.7, tier: 'regional' },
  { code: 'HZH', name: 'Liping', city: 'Qiandongnan', country: 'CN', lat: 26.32, lon: 109.15, population: 3.5, tier: 'regional' },
  { code: 'AEB', name: 'Baise Youjiang', city: 'Baise', country: 'CN', lat: 23.72, lon: 106.96, population: 3.6, tier: 'regional' },
  { code: 'JNZ', name: 'Jinzhou Bay', city: 'Jinzhou', country: 'CN', lat: 40.93, lon: 121.06, population: 2.9, tier: 'regional' },
  { code: 'MDG', name: 'Mudanjiang Hailang', city: 'Mudanjiang', country: 'CN', lat: 44.52, lon: 129.57, population: 2.3, tier: 'regional' },
  { code: 'TGO', name: 'Tongliao', city: 'Tongliao', country: 'CN', lat: 43.56, lon: 122.2, population: 2.8, tier: 'regional' },
  { code: 'THD', name: 'Tho Xuan', city: 'Thanh Hoa', country: 'VN', lat: 19.9, lon: 105.47, population: 3.6, tier: 'regional' },
  { code: 'TEN', name: 'Tongren Fenghuang', city: 'Tongren', country: 'CN', lat: 27.88, lon: 109.31, population: 3.1, tier: 'regional' },
  { code: 'MUX', name: 'Multan Intl', city: 'Multan', country: 'PK', lat: 30.2, lon: 71.42, population: 2, tier: 'regional' },
  { code: 'JDZ', name: 'Jingdezhen Luojia', city: 'Jingdezhen', country: 'CN', lat: 29.34, lon: 117.18, population: 1.6, tier: 'regional', visitors: 0.5 },
  { code: 'HZG', name: 'Hanzhong Chenggu', city: 'Hanzhong', country: 'CN', lat: 33.07, lon: 107.01, population: 3.2, tier: 'regional' },
  { code: 'ACX', name: 'Xingyi Wanfenglin', city: 'Xingyi', country: 'CN', lat: 25.09, lon: 104.96, population: 3.5, tier: 'regional' },
  { code: 'JMU', name: 'Jiamusi Dongjiao', city: 'Jiamusi', country: 'CN', lat: 46.84, lon: 130.46, population: 2.3, tier: 'regional' },
  { code: 'DOY', name: 'Dongying Shengli', city: 'Dongying', country: 'CN', lat: 37.51, lon: 118.79, population: 2.2, tier: 'regional' },
  { code: 'WNH', name: 'Wenshan Puzhehei', city: 'Wenshan', country: 'CN', lat: 23.55, lon: 104.32, population: 3.5, tier: 'regional' },
  { code: 'DDG', name: 'Dandong Langtou', city: 'Dandong', country: 'CN', lat: 40.02, lon: 124.29, population: 2.2, tier: 'regional' },
  { code: 'TXN', name: 'Huangshan Tunxi', city: 'Huangshan', country: 'CN', lat: 29.73, lon: 118.26, population: 1.4, tier: 'regional', visitors: 2 },
  { code: 'NAK', name: 'Nakhon Ratchasima', city: 'Nakhon Ratchasima', country: 'TH', lat: 14.95, lon: 102.31, population: 2.6, tier: 'regional' },
  { code: 'YYK', name: 'Yingkou Lanqi', city: 'Yingkou', country: 'CN', lat: 40.54, lon: 122.36, population: 2.3, tier: 'regional' },
  { code: 'AKA', name: 'Ankang Wulipu', city: 'Ankang', country: 'CN', lat: 32.71, lon: 108.93, population: 2.6, tier: 'regional' },
  { code: 'PEW', name: 'Bacha Khan Intl', city: 'Peshawar', country: 'PK', lat: 33.99, lon: 71.51, population: 2, tier: 'regional' },
  { code: 'SXR', name: 'Srinagar Intl', city: 'Srinagar', country: 'IN', lat: 33.99, lon: 74.77, population: 1.5, tier: 'regional', visitors: 1 },
  { code: 'AVA', name: 'Anshun Huangguoshu', city: 'Anshun', country: 'CN', lat: 26.26, lon: 105.87, population: 2.5, tier: 'regional', visitors: 0.5 },
  { code: 'LPF', name: 'Liupanshui Yuezhao', city: 'Liupanshui', country: 'CN', lat: 26.61, lon: 104.98, population: 3, tier: 'regional' },
  { code: 'BHY', name: 'Beihai Fucheng', city: 'Beihai', country: 'CN', lat: 21.54, lon: 109.29, population: 1.8, tier: 'regional', visitors: 0.5 },
  { code: 'DSN', name: 'Ordos Ejin Horo', city: 'Ordos', country: 'CN', lat: 39.49, lon: 109.86, population: 2.2, tier: 'regional' },
  { code: 'ENY', name: 'Yan\'an Nanniwan', city: 'Yan\'an', country: 'CN', lat: 36.37, lon: 109.55, population: 2.3, tier: 'regional' },
  { code: 'IXD', name: 'Prayagraj', city: 'Prayagraj', country: 'IN', lat: 25.44, lon: 81.74, population: 1.2, tier: 'regional', visitors: 0.5 },
  { code: 'JDH', name: 'Jodhpur', city: 'Jodhpur', country: 'IN', lat: 26.25, lon: 73.05, population: 1.1, tier: 'regional', visitors: 0.5 },
  { code: 'ISK', name: 'Nashik Ozar', city: 'Nashik', country: 'IN', lat: 20.12, lon: 73.91, population: 1.6, tier: 'regional' },
  { code: 'IQN', name: 'Qingyang Xifeng', city: 'Qingyang', country: 'CN', lat: 35.8, lon: 107.6, population: 2.2, tier: 'regional' },
  { code: 'GWL', name: 'Gwalior Rajmata', city: 'Gwalior', country: 'IN', lat: 26.29, lon: 78.23, population: 1.1, tier: 'regional' },
  { code: 'BSD', name: 'Baoshan Yunrui', city: 'Baoshan', country: 'CN', lat: 25.05, lon: 99.17, population: 2.5, tier: 'regional' },
  { code: 'IFN', name: 'Isfahan Shahid Beheshti', city: 'Isfahan', country: 'IR', lat: 32.75, lon: 51.86, population: 2.2, tier: 'regional' },
  { code: 'FMO', name: 'Munster Osnabruck', city: 'Munster', country: 'DE', lat: 52.13, lon: 7.68, population: 1.5, tier: 'regional' },
  { code: 'BEK', name: 'Bareilly', city: 'Bareilly', country: 'IN', lat: 28.42, lon: 79.45, population: 1, tier: 'regional' },
  { code: 'ADA', name: 'Adana Sakirpasa', city: 'Adana', country: 'TR', lat: 36.98, lon: 35.28, population: 2.2, tier: 'regional' },
  { code: 'SYZ', name: 'Shiraz Dastgheib', city: 'Shiraz', country: 'IR', lat: 29.54, lon: 52.59, population: 1.7, tier: 'regional' },
  { code: 'JLR', name: 'Jabalpur Dumna', city: 'Jabalpur', country: 'IN', lat: 23.18, lon: 80.05, population: 1.3, tier: 'regional' },
  { code: 'DED', name: 'Dehradun Jolly Grant', city: 'Dehradun', country: 'IN', lat: 30.19, lon: 78.18, population: 0.8, tier: 'regional', visitors: 0.8 },
  { code: 'IXW', name: 'Jamshedpur Sonari', city: 'Jamshedpur', country: 'IN', lat: 22.81, lon: 86.17, population: 1.6, tier: 'regional' },
  { code: 'WXN', name: 'Wanzhou Wuqiao', city: 'Wanzhou', country: 'CN', lat: 30.84, lon: 108.41, population: 1.6, tier: 'regional' },
  { code: 'IXU', name: 'Aurangabad', city: 'Aurangabad', country: 'IN', lat: 19.86, lon: 75.4, population: 1.2, tier: 'regional' },
  { code: 'CNN', name: 'Kannur Intl', city: 'Kannur', country: 'IN', lat: 11.92, lon: 75.55, population: 1.6, tier: 'regional' },
  { code: 'HEK', name: 'Heihe Aihui', city: 'Heihe', country: 'CN', lat: 50.17, lon: 127.31, population: 1.3, tier: 'regional' },
  { code: 'HTN', name: 'Hotan', city: 'Hotan', country: 'CN', lat: 37.04, lon: 79.86, population: 1.1, tier: 'regional' },
  { code: 'UET', name: 'Quetta Intl', city: 'Quetta', country: 'PK', lat: 30.25, lon: 66.94, population: 1.1, tier: 'regional' },
  { code: 'BHV', name: 'Bahawalpur', city: 'Bahawalpur', country: 'PK', lat: 29.35, lon: 71.72, population: 0.8, tier: 'regional' },
  { code: 'ROI', name: 'Roi Et', city: 'Roi Et', country: 'TH', lat: 16.12, lon: 103.77, population: 1.3, tier: 'regional' },
  { code: 'BKB', name: 'Bikaner Nal', city: 'Bikaner', country: 'IN', lat: 28.07, lon: 73.21, population: 0.7, tier: 'regional' },
  { code: 'AWZ', name: 'Ahvaz Intl', city: 'Ahvaz', country: 'IR', lat: 31.34, lon: 48.76, population: 1.3, tier: 'regional' },
  { code: 'DNZ', name: 'Denizli Cardak', city: 'Denizli', country: 'TR', lat: 37.79, lon: 29.7, population: 1, tier: 'regional', visitors: 0.8 },
  { code: 'ASR', name: 'Kayseri Erkilet', city: 'Kayseri', country: 'TR', lat: 38.77, lon: 35.49, population: 1.4, tier: 'regional' },
  { code: 'SSE', name: 'Solapur', city: 'Solapur', country: 'IN', lat: 17.63, lon: 75.93, population: 1, tier: 'regional' },
  { code: 'AAN', name: 'Al Ain Intl', city: 'Al Ain', country: 'AE', lat: 24.26, lon: 55.61, population: 0.77, tier: 'regional' },
  { code: 'GNY', name: 'Sanliurfa GAP', city: 'Sanliurfa', country: 'TR', lat: 37.45, lon: 38.9, population: 1.5, tier: 'regional' },
  { code: 'TBZ', name: 'Tabriz Intl', city: 'Tabriz', country: 'IR', lat: 38.13, lon: 46.24, population: 1.6, tier: 'regional' },
  { code: 'RJH', name: 'Shah Makhdum', city: 'Rajshahi', country: 'BD', lat: 24.44, lon: 88.62, population: 0.9, tier: 'regional' },
  { code: 'PAD', name: 'Paderborn Lippstadt', city: 'Paderborn', country: 'DE', lat: 51.61, lon: 8.62, population: 0.9, tier: 'regional' },
  { code: 'IMF', name: 'Imphal Bir Tikendrajit', city: 'Imphal', country: 'IN', lat: 24.76, lon: 93.9, population: 1, tier: 'regional' },
  { code: 'HBX', name: 'Hubli', city: 'Hubli-Dharwad', country: 'IN', lat: 15.36, lon: 75.08, population: 1, tier: 'regional' },
  { code: 'RKZ', name: 'Shigatse Peace', city: 'Shigatse', country: 'CN', lat: 29.35, lon: 89.31, population: 0.8, tier: 'regional', visitors: 0.5 },
  { code: 'YNJ', name: 'Yanji Chaoyangchuan', city: 'Yanji', country: 'CN', lat: 42.88, lon: 129.45, population: 0.7, tier: 'regional' },
  { code: 'MYQ', name: 'Mysuru', city: 'Mysuru', country: 'IN', lat: 12.23, lon: 76.66, population: 1, tier: 'regional', visitors: 0.5 },
  { code: 'GOP', name: 'Gorakhpur', city: 'Gorakhpur', country: 'IN', lat: 26.74, lon: 83.45, population: 0.7, tier: 'regional' },
  { code: 'BND', name: 'Bandar Abbas Intl', city: 'Bandar Abbas', country: 'IR', lat: 27.22, lon: 56.38, population: 0.7, tier: 'regional' },
  { code: 'DJB', name: 'Sultan Thaha', city: 'Jambi', country: 'ID', lat: -1.64, lon: 103.64, population: 0.6, tier: 'regional' },
  { code: 'VVO', name: 'Knevichi', city: 'Vladivostok', country: 'RU', lat: 43.4, lon: 132.15, population: 0.6, tier: 'regional' },
  { code: 'ZHY', name: 'Zhongwei Shapotou', city: 'Zhongwei', country: 'CN', lat: 37.57, lon: 105.15, population: 1.1, tier: 'regional' },
  { code: 'RAO', name: 'Leite Lopes', city: 'Ribeirao Preto', country: 'BR', lat: -21.13, lon: -47.77, population: 0.7, tier: 'regional' },
  { code: 'GOJ', name: 'Strigino', city: 'Nizhny Novgorod', country: 'RU', lat: 56.23, lon: 43.78, population: 1.3, tier: 'regional' },
  { code: 'KER', name: 'Kerman', city: 'Kerman', country: 'IR', lat: 30.27, lon: 56.95, population: 0.8, tier: 'regional' },
  { code: 'PZI', name: 'Panzhihua Bao\'anying', city: 'Panzhihua', country: 'CN', lat: 26.54, lon: 101.8, population: 1.2, tier: 'regional' },
  { code: 'FKS', name: 'Fukushima', city: 'Fukushima', country: 'JP', lat: 37.23, lon: 140.43, population: 0.29, tier: 'regional' },
  { code: 'DIY', name: 'Diyarbakir', city: 'Diyarbakir', country: 'TR', lat: 37.89, lon: 40.2, population: 1.1, tier: 'regional' },
  { code: 'KHV', name: 'Novy', city: 'Khabarovsk', country: 'RU', lat: 48.53, lon: 135.19, population: 0.6, tier: 'regional' },
  { code: 'GAY', name: 'Gaya Bodhgaya', city: 'Gaya', country: 'IN', lat: 24.74, lon: 84.95, population: 0.5, tier: 'regional', visitors: 1 },
  { code: 'KRR', name: 'Pashkovsky', city: 'Krasnodar', country: 'RU', lat: 45.03, lon: 39.17, population: 1.1, tier: 'regional' },
  { code: 'SLZ', name: 'Marechal Cunha Machado', city: 'Sao Luis', country: 'BR', lat: -2.59, lon: -44.23, population: 1.6, tier: 'regional' },
  { code: 'KSH', name: 'Kermanshah', city: 'Kermanshah', country: 'IR', lat: 34.35, lon: 47.16, population: 0.95, tier: 'regional' },
  { code: 'DEA', name: 'Dera Ghazi Khan', city: 'Dera Ghazi Khan', country: 'PK', lat: 29.96, lon: 70.49, population: 0.5, tier: 'regional' },
  { code: 'SXV', name: 'Salem', city: 'Salem', country: 'IN', lat: 11.78, lon: 78.07, population: 0.9, tier: 'regional' },
  { code: 'KLH', name: 'Kolhapur', city: 'Kolhapur', country: 'IN', lat: 16.66, lon: 74.29, population: 0.6, tier: 'regional' },
  { code: 'MZR', name: 'Mazar-i-Sharif Intl', city: 'Mazar-i-Sharif', country: 'AF', lat: 36.71, lon: 67.21, population: 0.7, tier: 'regional' },
  { code: 'ISU', name: 'Sulaymaniyah Intl', city: 'Sulaymaniyah', country: 'IQ', lat: 35.56, lon: 45.32, population: 1, tier: 'regional' },
  { code: 'NDC', name: 'Nanded', city: 'Nanded', country: 'IN', lat: 19.18, lon: 77.32, population: 0.6, tier: 'regional' },
  { code: 'XIC', name: 'Xichang Qingshan', city: 'Xichang', country: 'CN', lat: 27.99, lon: 102.18, population: 0.95, tier: 'regional' },
  { code: 'PKR', name: 'Pokhara Intl', city: 'Pokhara', country: 'NP', lat: 28.2, lon: 83.98, population: 0.4, tier: 'regional', visitors: 1.5, gateway: 0.3 },
  { code: 'BAR', name: 'Qionghai Bo\'ao', city: 'Qionghai', country: 'CN', lat: 19.14, lon: 110.45, population: 0.5, tier: 'regional', visitors: 0.8 },
  { code: 'VOZ', name: 'Chertovitskoye', city: 'Voronezh', country: 'RU', lat: 51.81, lon: 39.23, population: 1, tier: 'regional' },
  { code: 'SKZ', name: 'Sukkur', city: 'Sukkur', country: 'PK', lat: 27.72, lon: 68.79, population: 0.5, tier: 'regional' },
  { code: 'BKS', name: 'Fatmawati Soekarno', city: 'Bengkulu', country: 'ID', lat: -3.86, lon: 102.34, population: 0.4, tier: 'regional' },
  { code: 'TJQ', name: 'H.A.S. Hanandjoeddin', city: 'Tanjung Pandan', country: 'ID', lat: -2.74, lon: 107.75, population: 0.3, tier: 'regional', visitors: 0.5 },
  { code: 'BUZ', name: 'Bushehr', city: 'Bushehr', country: 'IR', lat: 28.94, lon: 50.83, population: 0.6, tier: 'regional' },
  { code: 'KUF', name: 'Kurumoch', city: 'Samara', country: 'RU', lat: 53.51, lon: 50.16, population: 1.2, tier: 'regional' },
  { code: 'DLU', name: 'Dali', city: 'Dali', country: 'CN', lat: 25.65, lon: 100.32, population: 0.7, tier: 'regional', visitors: 1.5 },
  { code: 'ZYL', name: 'Osmani Intl', city: 'Sylhet', country: 'BD', lat: 24.96, lon: 91.87, population: 0.5, tier: 'regional' },
  { code: 'BAQ', name: 'Ernesto Cortissoz', city: 'Barranquilla', country: 'CO', lat: 10.89, lon: -74.78, population: 1.3, tier: 'regional' },
  { code: 'NMA', name: 'Namangan', city: 'Namangan', country: 'UZ', lat: 40.98, lon: 71.56, population: 0.65, tier: 'regional' },
  { code: 'ZAH', name: 'Zahedan', city: 'Zahedan', country: 'IR', lat: 29.48, lon: 60.91, population: 0.6, tier: 'regional' },
  { code: 'LUM', name: 'Mangshi Dehong', city: 'Mangshi', country: 'CN', lat: 24.4, lon: 98.53, population: 0.6, tier: 'regional', visitors: 0.3 },
  { code: 'HKD', name: 'Hakodate', city: 'Hakodate', country: 'JP', lat: 41.77, lon: 140.82, population: 0.25, tier: 'regional', visitors: 0.8 },
  { code: 'REW', name: 'Rewa', city: 'Rewa', country: 'IN', lat: 24.5, lon: 81.22, population: 0.4, tier: 'regional' },
  { code: 'SAG', name: 'Sangli', city: 'Sangli', country: 'IN', lat: 16.92, lon: 74.62, population: 0.5, tier: 'regional' },
  { code: 'CBB', name: 'Jorge Wilstermann', city: 'Cochabamba', country: 'BO', lat: -17.42, lon: -66.18, population: 1.2, tier: 'regional' },
  { code: 'HDM', name: 'Hamadan', city: 'Hamadan', country: 'IR', lat: 34.87, lon: 48.55, population: 0.7, tier: 'regional' },
  { code: 'MDZ', name: 'El Plumerillo', city: 'Mendoza', country: 'AR', lat: -32.83, lon: -68.79, population: 1, tier: 'regional' },
  { code: 'RAS', name: 'Rasht', city: 'Rasht', country: 'IR', lat: 37.32, lon: 49.62, population: 0.7, tier: 'regional' },
  { code: 'TTR', name: 'Pongtiku Toraja', city: 'Tana Toraja', country: 'ID', lat: -3.04, lon: 119.82, population: 0.5, tier: 'regional', visitors: 0.5 },
  { code: 'RYK', name: 'Shaikh Zayed', city: 'Rahim Yar Khan', country: 'PK', lat: 28.38, lon: 70.28, population: 0.4, tier: 'regional' },
  { code: 'PGH', name: 'Pantnagar', city: 'Pantnagar', country: 'IN', lat: 29.03, lon: 79.47, population: 0.3, tier: 'regional' },
  { code: 'AKU', name: 'Aksu Hongqipo', city: 'Aksu', country: 'CN', lat: 41.26, lon: 80.29, population: 0.6, tier: 'regional' },
  { code: 'IXE', name: 'Mangalore Intl', city: 'Mangalore', country: 'IN', lat: 12.96, lon: 74.89, population: 0.6, tier: 'regional' },
  { code: 'BUP', name: 'Bathinda', city: 'Bathinda', country: 'IN', lat: 30.27, lon: 74.76, population: 0.3, tier: 'regional' },
  { code: 'CEK', name: 'Balandino', city: 'Chelyabinsk', country: 'RU', lat: 55.31, lon: 61.5, population: 1.2, tier: 'regional' },
  { code: 'HEA', name: 'Herat Intl', city: 'Herat', country: 'AF', lat: 34.21, lon: 62.23, population: 0.6, tier: 'regional' },
  { code: 'FMM', name: 'Memmingen Allgau', city: 'Memmingen', country: 'DE', lat: 47.99, lon: 10.24, population: 0.5, tier: 'regional' },
  { code: 'BWA', name: 'Gautam Buddha Intl', city: 'Bhairahawa', country: 'NP', lat: 27.51, lon: 83.42, population: 0.3, tier: 'regional', visitors: 0.5 },
  { code: 'VAR', name: 'Varna', city: 'Varna', country: 'BG', lat: 43.23, lon: 27.83, population: 0.4, tier: 'regional', visitors: 0.6 },
  { code: 'TIR', name: 'Tirupati', city: 'Tirupati', country: 'IN', lat: 13.63, lon: 79.54, population: 0.5, tier: 'regional', visitors: 1.5 },
  { code: 'KRL', name: 'Korla Licheng', city: 'Korla', country: 'CN', lat: 41.7, lon: 86.13, population: 0.6, tier: 'regional' },
  { code: 'SYM', name: 'Simao Pu\'er', city: 'Pu\'er', country: 'CN', lat: 22.79, lon: 100.96, population: 0.7, tier: 'regional' },
  { code: 'HUN', name: 'Hualien', city: 'Hualien', country: 'TW', lat: 24.02, lon: 121.62, population: 0.32, tier: 'regional', visitors: 0.8 },
  { code: 'DBR', name: 'Darbhanga', city: 'Darbhanga', country: 'IN', lat: 26.19, lon: 85.92, population: 0.4, tier: 'regional' },
  { code: 'RJA', name: 'Rajahmundry', city: 'Rajahmundry', country: 'IN', lat: 17.11, lon: 81.82, population: 0.5, tier: 'regional' },
  { code: 'CCP', name: 'Carriel Sur', city: 'Concepcion', country: 'CL', lat: -36.77, lon: -73.06, population: 1, tier: 'regional' },
  { code: 'KKC', name: 'Khon Kaen', city: 'Khon Kaen', country: 'TH', lat: 16.47, lon: 102.78, population: 0.5, tier: 'regional' },
  { code: 'WUS', name: 'Wuyishan', city: 'Wuyishan', country: 'CN', lat: 27.7, lon: 118, population: 0.26, tier: 'regional', visitors: 1 },
  { code: 'TRU', name: 'Carlos Martinez de Pinillos', city: 'Trujillo', country: 'PE', lat: -8.08, lon: -79.11, population: 0.9, tier: 'regional' },
  { code: 'KJB', name: 'Kurnool Orvakal', city: 'Kurnool', country: 'IN', lat: 15.71, lon: 78.21, population: 0.5, tier: 'regional' },
  { code: 'RTW', name: 'Gagarin', city: 'Saratov', country: 'RU', lat: 51.71, lon: 46.17, population: 0.83, tier: 'regional' },
  { code: 'OMH', name: 'Urmia', city: 'Urmia', country: 'IR', lat: 37.67, lon: 45.07, population: 0.7, tier: 'regional' },
  { code: 'PEE', name: 'Bolshoye Savino', city: 'Perm', country: 'RU', lat: 57.91, lon: 56.02, population: 1, tier: 'regional' },
  { code: 'KCA', name: 'Kuqa Qiuci', city: 'Kuqa', country: 'CN', lat: 41.68, lon: 82.91, population: 0.5, tier: 'regional' },
  { code: 'SUF', name: 'Lamezia Terme', city: 'Lamezia Terme', country: 'IT', lat: 38.91, lon: 16.24, population: 0.7, tier: 'regional' },
  { code: 'CDP', name: 'Kadapa', city: 'Kadapa', country: 'IN', lat: 14.51, lon: 78.77, population: 0.5, tier: 'regional' },
  { code: 'GES', name: 'General Santos Intl', city: 'General Santos', country: 'PH', lat: 6.06, lon: 125.1, population: 0.7, tier: 'regional' },
  { code: 'AJF', name: 'Al-Jawf', city: 'Sakaka', country: 'SA', lat: 29.79, lon: 40.1, population: 0.5, tier: 'regional' },
  { code: 'DMU', name: 'Dimapur', city: 'Dimapur', country: 'IN', lat: 25.88, lon: 93.77, population: 0.4, tier: 'regional' },
  { code: 'EZS', name: 'Elazig', city: 'Elazig', country: 'TR', lat: 38.61, lon: 39.29, population: 0.6, tier: 'regional' },
  { code: 'DLI', name: 'Lien Khuong', city: 'Dalat', country: 'VN', lat: 11.75, lon: 108.37, population: 0.4, tier: 'regional', visitors: 1 },
  { code: 'VII', name: 'Vinh', city: 'Vinh', country: 'VN', lat: 18.74, lon: 105.67, population: 0.5, tier: 'regional' },
  { code: 'JAF', name: 'Jaffna', city: 'Jaffna', country: 'LK', lat: 9.79, lon: 80.07, population: 0.6, tier: 'regional' },
  { code: 'BAL', name: 'Batman', city: 'Batman', country: 'TR', lat: 37.93, lon: 41.12, population: 0.6, tier: 'regional' },
  { code: 'YIN', name: 'Yining', city: 'Yining', country: 'CN', lat: 43.96, lon: 81.33, population: 0.5, tier: 'regional' },
  { code: 'HMI', name: 'Hami', city: 'Hami', country: 'CN', lat: 42.84, lon: 93.67, population: 0.6, tier: 'regional' },
  { code: 'SBZ', name: 'Sibiu', city: 'Sibiu', country: 'RO', lat: 45.79, lon: 24.09, population: 0.4, tier: 'regional', visitors: 0.4 },
  { code: 'UND', name: 'Kunduz', city: 'Kunduz', country: 'AF', lat: 36.67, lon: 68.91, population: 0.37, tier: 'regional' },
  { code: 'PDV', name: 'Plovdiv', city: 'Plovdiv', country: 'BG', lat: 42.07, lon: 24.85, population: 0.4, tier: 'regional' },
  { code: 'MCX', name: 'Uytash', city: 'Makhachkala', country: 'RU', lat: 42.82, lon: 47.65, population: 0.7, tier: 'regional' },
  { code: 'GBT', name: 'Gorgan', city: 'Gorgan', country: 'IR', lat: 36.91, lon: 54.4, population: 0.5, tier: 'regional' },
  { code: 'SLA', name: 'Martin Miguel de Guemes', city: 'Salta', country: 'AR', lat: -24.86, lon: -65.49, population: 0.6, tier: 'regional', visitors: 0.5 },
  { code: 'KGD', name: 'Khrabrovo', city: 'Kaliningrad', country: 'RU', lat: 54.89, lon: 20.59, population: 0.5, tier: 'regional' },
  { code: 'BEP', name: 'Bellary', city: 'Bellary', country: 'IN', lat: 15.16, lon: 76.88, population: 0.4, tier: 'regional' },
  { code: 'YNY', name: 'Yangyang Intl', city: 'Sokcho', country: 'KR', lat: 38.06, lon: 128.67, population: 0.2, tier: 'regional', visitors: 0.5 },
  { code: 'SDG', name: 'Sanandaj', city: 'Sanandaj', country: 'IR', lat: 35.25, lon: 47.01, population: 0.5, tier: 'regional' },
  { code: 'JSR', name: 'Jessore', city: 'Jessore', country: 'BD', lat: 23.18, lon: 89.16, population: 0.3, tier: 'regional' },
  { code: 'PLW', name: 'Mutiara SIS Al-Jufri', city: 'Palu', country: 'ID', lat: -0.92, lon: 119.91, population: 0.4, tier: 'regional' },
  { code: 'AJL', name: 'Aizawl Lengpui', city: 'Aizawl', country: 'IN', lat: 23.84, lon: 92.62, population: 0.3, tier: 'regional' },
  { code: 'ULY', name: 'Barataevka', city: 'Ulyanovsk', country: 'RU', lat: 54.27, lon: 48.23, population: 0.62, tier: 'regional' },
  { code: 'TUG', name: 'Tuguegarao', city: 'Tuguegarao', country: 'PH', lat: 17.64, lon: 121.73, population: 0.4, tier: 'regional' },
  { code: 'SBW', name: 'Sibu', city: 'Sibu', country: 'MY', lat: 2.26, lon: 111.99, population: 0.3, tier: 'regional' },
  { code: 'JRG', name: 'Jharsuguda', city: 'Jharsuguda', country: 'IN', lat: 21.91, lon: 84.05, population: 0.3, tier: 'regional' },
  { code: 'BIR', name: 'Biratnagar', city: 'Biratnagar', country: 'NP', lat: 26.48, lon: 87.26, population: 0.3, tier: 'regional' },
  { code: 'LCG', name: 'A Coruna', city: 'A Coruna', country: 'ES', lat: 43.3, lon: -8.38, population: 0.37, tier: 'regional' },
  { code: 'PGK', name: 'Depati Amir', city: 'Pangkal Pinang', country: 'ID', lat: -2.16, lon: 106.14, population: 0.2, tier: 'regional' },
  { code: 'PBD', name: 'Porbandar', city: 'Porbandar', country: 'IN', lat: 21.65, lon: 69.66, population: 0.3, tier: 'regional' },
  { code: 'KDI', name: 'Haluoleo', city: 'Kendari', country: 'ID', lat: -4.08, lon: 122.42, population: 0.4, tier: 'regional' },
  { code: 'AQI', name: 'Hafr Al-Batin', city: 'Hafr Al-Batin', country: 'SA', lat: 27.84, lon: 45.53, population: 0.4, tier: 'regional' },
  { code: 'TCR', name: 'Tuticorin', city: 'Thoothukudi', country: 'IN', lat: 8.72, lon: 78.03, population: 0.5, tier: 'regional' },
  { code: 'BOJ', name: 'Burgas', city: 'Burgas', country: 'BG', lat: 42.57, lon: 27.52, population: 0.25, tier: 'regional', visitors: 1 },
  { code: 'HLD', name: 'Hailar Dongshan', city: 'Hulunbuir', country: 'CN', lat: 49.2, lon: 119.83, population: 0.3, tier: 'regional', visitors: 0.4 },
  { code: 'PEI', name: 'Matecana', city: 'Pereira', country: 'CO', lat: 4.81, lon: -75.74, population: 0.5, tier: 'regional' },
  { code: 'NWI', name: 'Norwich', city: 'Norwich', country: 'GB', lat: 52.68, lon: 1.28, population: 0.2, tier: 'regional' },
  { code: 'PEZ', name: 'Penza', city: 'Penza', country: 'RU', lat: 53.11, lon: 45.02, population: 0.52, tier: 'regional' },
  { code: 'IJK', name: 'Izhevsk', city: 'Izhevsk', country: 'RU', lat: 56.83, lon: 53.46, population: 0.65, tier: 'regional' },
  { code: 'KHD', name: 'Khorramabad', city: 'Khorramabad', country: 'IR', lat: 33.44, lon: 48.28, population: 0.4, tier: 'regional' },
  { code: 'SDT', name: 'Saidu Sharif', city: 'Swat', country: 'PK', lat: 34.81, lon: 72.35, population: 0.2, tier: 'regional', visitors: 0.4 },
  { code: 'SVG', name: 'Stavanger Sola', city: 'Stavanger', country: 'NO', lat: 58.88, lon: 5.64, population: 0.3, tier: 'regional' },
  { code: 'GTO', name: 'Jalaluddin', city: 'Gorontalo', country: 'ID', lat: 0.64, lon: 122.85, population: 0.4, tier: 'regional' },
  { code: 'LDE', name: 'Tarbes-Lourdes-Pyrenees', city: 'Lourdes', country: 'FR', lat: 43.18, lon: -0.01, population: 0.25, tier: 'regional', visitors: 1 },
  { code: 'KGF', name: 'Sary-Arka', city: 'Karaganda', country: 'KZ', lat: 49.67, lon: 73.33, population: 0.5, tier: 'regional' },
  { code: 'NAV', name: 'Nevsehir Kapadokya', city: 'Nevsehir', country: 'TR', lat: 38.77, lon: 34.53, population: 0.3, tier: 'regional', visitors: 1.2 },
  { code: 'GIL', name: 'Gilgit', city: 'Gilgit', country: 'PK', lat: 35.92, lon: 74.33, population: 0.2, tier: 'regional', visitors: 0.5 },
  { code: 'BHK', name: 'Bukhara Intl', city: 'Bukhara', country: 'UZ', lat: 39.78, lon: 64.48, population: 0.3, tier: 'regional', visitors: 0.6 },
  { code: 'PSU', name: 'Iskandar', city: 'Pangkalan Bun', country: 'ID', lat: -2.71, lon: 111.67, population: 0.2, tier: 'regional' },
  { code: 'BFV', name: 'Buriram', city: 'Buriram', country: 'TH', lat: 15.23, lon: 103.25, population: 0.3, tier: 'regional' },
  { code: 'KUH', name: 'Kushiro Tancho', city: 'Kushiro', country: 'JP', lat: 43.04, lon: 144.19, population: 0.17, tier: 'regional' },
  { code: 'NLT', name: 'Nalati', city: 'Xinyuan', country: 'CN', lat: 43.43, lon: 83.38, population: 0.3, tier: 'regional', visitors: 0.5 },
  { code: 'BTJ', name: 'Sultan Iskandar Muda', city: 'Banda Aceh', country: 'ID', lat: 5.52, lon: 95.42, population: 0.3, tier: 'regional' },
  { code: 'PHS', name: 'Phitsanulok', city: 'Phitsanulok', country: 'TH', lat: 16.78, lon: 100.28, population: 0.3, tier: 'regional' },
  { code: 'OBO', name: 'Tokachi-Obihiro', city: 'Obihiro', country: 'JP', lat: 42.73, lon: 143.22, population: 0.16, tier: 'regional' },
  { code: 'KRY', name: 'Karamay', city: 'Karamay', country: 'CN', lat: 45.62, lon: 84.95, population: 0.4, tier: 'regional' },
  { code: 'UUS', name: 'Khomutovo', city: 'Yuzhno-Sakhalinsk', country: 'RU', lat: 46.89, lon: 142.72, population: 0.2, tier: 'regional' },
  { code: 'SMR', name: 'Simon Bolivar', city: 'Santa Marta', country: 'CO', lat: 11.12, lon: -74.23, population: 0.5, tier: 'regional', visitors: 1 },
  { code: 'UUD', name: 'Mukhino', city: 'Ulan-Ude', country: 'RU', lat: 51.81, lon: 107.44, population: 0.43, tier: 'regional' },
  { code: 'EAM', name: 'Najran', city: 'Najran', country: 'SA', lat: 17.61, lon: 44.42, population: 0.4, tier: 'regional' },
  { code: 'NOZ', name: 'Spichenkovo', city: 'Novokuznetsk', country: 'RU', lat: 53.81, lon: 86.88, population: 0.55, tier: 'regional' },
  { code: 'CXB', name: 'Cox\'s Bazar', city: 'Cox\'s Bazar', country: 'BD', lat: 21.45, lon: 91.96, population: 0.2, tier: 'regional', visitors: 1 },
  { code: 'LRT', name: 'Lorient Bretagne Sud', city: 'Lorient', country: 'FR', lat: 47.76, lon: -3.44, population: 0.2, tier: 'regional' },
  { code: 'TOF', name: 'Bogashevo', city: 'Tomsk', country: 'RU', lat: 56.38, lon: 85.21, population: 0.57, tier: 'regional' },
  { code: 'HTA', name: 'Kadala', city: 'Chita', country: 'RU', lat: 52.03, lon: 113.31, population: 0.35, tier: 'regional' },
  { code: 'LZY', name: 'Nyingchi Mainling', city: 'Nyingchi', country: 'CN', lat: 29.3, lon: 94.34, population: 0.24, tier: 'regional', visitors: 0.5 },
  { code: 'PIU', name: 'Capitan Concha', city: 'Piura', country: 'PE', lat: -5.21, lon: -80.62, population: 0.6, tier: 'regional' },
  { code: 'REN', name: 'Orenburg Tsentralny', city: 'Orenburg', country: 'RU', lat: 51.8, lon: 55.46, population: 0.55, tier: 'regional' },
  { code: 'OSR', name: 'Ostrava Leos Janacek', city: 'Ostrava', country: 'CZ', lat: 49.7, lon: 18.11, population: 0.3, tier: 'regional' },
  { code: 'AKX', name: 'Aktobe', city: 'Aktobe', country: 'KZ', lat: 50.25, lon: 57.21, population: 0.5, tier: 'regional' },
  { code: 'CAH', name: 'Ca Mau', city: 'Ca Mau', country: 'VN', lat: 9.18, lon: 105.18, population: 0.23, tier: 'regional' },
  { code: 'LUZ', name: 'Lublin', city: 'Lublin', country: 'PL', lat: 51.24, lon: 22.71, population: 0.34, tier: 'regional' },
  { code: 'BHJ', name: 'Bhuj Rudra Mata', city: 'Bhuj', country: 'IN', lat: 23.29, lon: 69.67, population: 0.2, tier: 'regional' },
  { code: 'PNZ', name: 'Senador Nilo Coelho', city: 'Petrolina', country: 'BR', lat: -9.36, lon: -40.57, population: 0.4, tier: 'regional' },
  { code: 'BXU', name: 'Bancasi', city: 'Butuan', country: 'PH', lat: 8.95, lon: 125.48, population: 0.4, tier: 'regional' },
  { code: 'ASF', name: 'Narimanovo', city: 'Astrakhan', country: 'RU', lat: 46.28, lon: 48.01, population: 0.5, tier: 'regional' },
  { code: 'CUE', name: 'Mariscal Lamar', city: 'Cuenca', country: 'EC', lat: -2.89, lon: -78.98, population: 0.6, tier: 'regional' },
  { code: 'AXM', name: 'El Eden', city: 'Armenia', country: 'CO', lat: 4.45, lon: -75.77, population: 0.3, tier: 'regional', visitors: 0.4 },
  { code: 'TCD', name: 'Tarapacá Airport',               city: 'Tarapacá',        country: 'CO', lat: -2.87,  lon: -69.73,   population: 0.008, tier: 'regional' },
  { code: 'CRA', name: 'Craiova', city: 'Craiova', country: 'RO', lat: 44.32, lon: 23.89, population: 0.27, tier: 'regional' },
  { code: 'KSF', name: 'Kassel', city: 'Kassel', country: 'DE', lat: 51.41, lon: 9.38, population: 0.2, tier: 'regional' },
  { code: 'RUP', name: 'Rupsi', city: 'Dhubri', country: 'IN', lat: 26.14, lon: 89.91, population: 0.2, tier: 'regional' },
  { code: 'SPD', name: 'Saidpur', city: 'Saidpur', country: 'BD', lat: 25.76, lon: 88.91, population: 0.2, tier: 'regional' },
  { code: 'IXS', name: 'Silchar Kumbhirgram', city: 'Silchar', country: 'IN', lat: 24.91, lon: 92.98, population: 0.2, tier: 'regional' },
  { code: 'BQS', name: 'Ignatyevo', city: 'Blagoveshchensk', country: 'RU', lat: 50.43, lon: 127.41, population: 0.22, tier: 'regional' },
  { code: 'TKU', name: 'Turku', city: 'Turku', country: 'FI', lat: 60.51, lon: 22.26, population: 0.33, tier: 'regional' },
  { code: 'TST', name: 'Trang', city: 'Trang', country: 'TH', lat: 7.51, lon: 99.62, population: 0.2, tier: 'regional' },
  { code: 'CEE', name: 'Cherepovets', city: 'Cherepovets', country: 'RU', lat: 59.27, lon: 38.02, population: 0.31, tier: 'regional' },
  { code: 'BTU', name: 'Bintulu', city: 'Bintulu', country: 'MY', lat: 3.12, lon: 113.02, population: 0.2, tier: 'regional' },
  { code: 'INI', name: 'Nis Constantine', city: 'Nis', country: 'RS', lat: 43.34, lon: 21.85, population: 0.26, tier: 'regional' },
  { code: 'NLH', name: 'Ninglang Lugu Lake', city: 'Lijiang', country: 'CN', lat: 27.54, lon: 100.76, population: 0.25, tier: 'regional', visitors: 0.6 },
  { code: 'YKS', name: 'Yakutsk', city: 'Yakutsk', country: 'RU', lat: 62.09, lon: 129.77, population: 0.32, tier: 'regional' },
  { code: 'KZO', name: 'Kyzylorda', city: 'Kyzylorda', country: 'KZ', lat: 44.71, lon: 65.59, population: 0.3, tier: 'regional' },
  { code: 'KUU', name: 'Kullu Manali', city: 'Kullu', country: 'IN', lat: 31.88, lon: 77.15, population: 0.1, tier: 'regional', visitors: 0.6 },
  { code: 'DHM', name: 'Kangra Dharamshala', city: 'Dharamshala', country: 'IN', lat: 32.16, lon: 76.26, population: 0.1, tier: 'regional', visitors: 0.6 },
  { code: 'MMB', name: 'Memanbetsu', city: 'Abashiri', country: 'JP', lat: 43.88, lon: 144.16, population: 0.1, tier: 'regional', visitors: 0.4 },
  { code: 'MCP', name: 'Alberto Alcolumbre', city: 'Macapa', country: 'BR', lat: 0.05, lon: -51.07, population: 0.5, tier: 'regional' },
  { code: 'NCU', name: 'Nukus', city: 'Nukus', country: 'UZ', lat: 42.49, lon: 59.62, population: 0.3, tier: 'regional' },
  { code: 'PXU', name: 'Pleiku', city: 'Pleiku', country: 'VN', lat: 14, lon: 108.02, population: 0.25, tier: 'regional' },
  { code: 'PWQ', name: 'Pavlodar', city: 'Pavlodar', country: 'KZ', lat: 52.2, lon: 77.07, population: 0.35, tier: 'regional' },
  { code: 'TUK', name: 'Turbat', city: 'Turbat', country: 'PK', lat: 25.99, lon: 63.03, population: 0.2, tier: 'regional' },
  { code: 'ZCO', name: 'La Araucania', city: 'Temuco', country: 'CL', lat: -38.93, lon: -72.65, population: 0.4, tier: 'regional' },
  { code: 'CBO', name: 'Awang', city: 'Cotabato', country: 'PH', lat: 7.17, lon: 124.21, population: 0.3, tier: 'regional' },
  { code: 'CEI', name: 'Chiang Rai Mae Fah Luang', city: 'Chiang Rai', country: 'TH', lat: 19.95, lon: 99.88, population: 0.2, tier: 'regional', visitors: 1 },
  { code: 'LGP', name: 'Bicol Intl', city: 'Legazpi', country: 'PH', lat: 13.16, lon: 123.74, population: 0.2, tier: 'regional', visitors: 0.5 },
  { code: 'LBD', name: 'Khujand', city: 'Khujand', country: 'TJ', lat: 40.21, lon: 69.69, population: 0.2, tier: 'regional' },
  { code: 'KVD', name: 'Ganja Intl', city: 'Ganja', country: 'AZ', lat: 40.74, lon: 46.32, population: 0.3, tier: 'regional' },
  { code: 'PKC', name: 'Yelizovo', city: 'Petropavlovsk-Kamchatsky', country: 'RU', lat: 53.17, lon: 158.45, population: 0.18, tier: 'regional', visitors: 0.4 },
  { code: 'TMJ', name: 'Termez', city: 'Termez', country: 'UZ', lat: 37.29, lon: 67.31, population: 0.18, tier: 'regional' },
  { code: 'KSC', name: 'Kosice', city: 'Kosice', country: 'SK', lat: 48.66, lon: 21.24, population: 0.24, tier: 'regional' },
  { code: 'ANF', name: 'Andres Sabella', city: 'Antofagasta', country: 'CL', lat: -23.44, lon: -70.45, population: 0.4, tier: 'regional' },
  { code: 'RGS', name: 'Burgos', city: 'Burgos', country: 'ES', lat: 42.36, lon: -3.62, population: 0.18, tier: 'regional' },
  { code: 'ARH', name: 'Talagi', city: 'Arkhangelsk', country: 'RU', lat: 64.6, lon: 40.72, population: 0.35, tier: 'regional' },
  { code: 'UGC', name: 'Urgench', city: 'Urgench', country: 'UZ', lat: 41.58, lon: 60.64, population: 0.2, tier: 'regional', visitors: 0.6 },
  { code: 'PIS', name: 'Poitiers-Biard', city: 'Poitiers', country: 'FR', lat: 46.59, lon: 0.31, population: 0.13, tier: 'regional' },
  { code: 'TAC', name: 'Daniel Z. Romualdez', city: 'Tacloban', country: 'PH', lat: 11.23, lon: 125.03, population: 0.25, tier: 'regional' },
  { code: 'VDH', name: 'Dong Hoi', city: 'Dong Hoi', country: 'VN', lat: 17.52, lon: 106.59, population: 0.16, tier: 'regional', visitors: 0.4 },
  { code: 'IOS', name: 'Bahia-Jorge Amado', city: 'Ilheus', country: 'BR', lat: -14.82, lon: -39.03, population: 0.18, tier: 'regional', visitors: 0.6 },
  { code: 'RAE', name: 'Arar', city: 'Arar', country: 'SA', lat: 30.91, lon: 41.14, population: 0.2, tier: 'regional' },
  { code: 'WNP', name: 'Naga', city: 'Naga', country: 'PH', lat: 13.58, lon: 123.27, population: 0.2, tier: 'regional' },
  { code: 'DNH', name: 'Dunhuang Mogao', city: 'Dunhuang', country: 'CN', lat: 40.16, lon: 94.81, population: 0.19, tier: 'regional', visitors: 1 },
  { code: 'TBB', name: 'Tuy Hoa', city: 'Tuy Hoa', country: 'VN', lat: 13.05, lon: 109.33, population: 0.2, tier: 'regional' },
  { code: 'DTB', name: 'Sisingamangaraja Silangit', city: 'Siborong-Borong', country: 'ID', lat: 2.26, lon: 98.99, population: 0.1, tier: 'regional', visitors: 0.6 },
  { code: 'GPA', name: 'Patras Araxos', city: 'Patras', country: 'GR', lat: 38.15, lon: 21.42, population: 0.2, tier: 'regional' },
  { code: 'RBR', name: 'Placido de Castro', city: 'Rio Branco', country: 'BR', lat: -9.87, lon: -67.89, population: 0.4, tier: 'regional' },
  { code: 'KVA', name: 'Kavala Megas Alexandros', city: 'Kavala', country: 'GR', lat: 40.91, lon: 24.62, population: 0.13, tier: 'regional', visitors: 0.5 },
  { code: 'JUL', name: 'Inca Manco Capac', city: 'Juliaca', country: 'PE', lat: -15.47, lon: -70.16, population: 0.3, tier: 'regional', visitors: 0.8 },
  { code: 'GOQ', name: 'Golmud', city: 'Golmud', country: 'CN', lat: 36.4, lon: 94.79, population: 0.2, tier: 'regional' },
  { code: 'AAT', name: 'Altay', city: 'Altay', country: 'CN', lat: 47.75, lon: 88.08, population: 0.2, tier: 'regional', visitors: 0.4 },
  { code: 'URY', name: 'Gurayat', city: 'Gurayat', country: 'SA', lat: 31.41, lon: 37.28, population: 0.15, tier: 'regional' },
  { code: 'MZG', name: 'Penghu Magong', city: 'Magong', country: 'TW', lat: 23.57, lon: 119.63, population: 0.1, tier: 'regional', visitors: 0.6 },
  { code: 'BPS', name: 'Porto Seguro', city: 'Porto Seguro', country: 'BR', lat: -16.44, lon: -39.08, population: 0.15, tier: 'regional', visitors: 1 },
  { code: 'SGC', name: 'Surgut', city: 'Surgut', country: 'RU', lat: 61.34, lon: 73.4, population: 0.38, tier: 'regional' },
  { code: 'JDO', name: 'Orlando Bezerra', city: 'Juazeiro do Norte', country: 'BR', lat: -7.22, lon: -39.27, population: 0.27, tier: 'regional' },
  { code: 'LGK', name: 'Langkawi Intl', city: 'Langkawi', country: 'MY', lat: 6.33, lon: 99.73, population: 0.1, tier: 'regional', visitors: 1 },
  { code: 'DEB', name: 'Debrecen', city: 'Debrecen', country: 'HU', lat: 47.49, lon: 21.62, population: 0.2, tier: 'regional' },
  { code: 'MMK', name: 'Murmansk', city: 'Murmansk', country: 'RU', lat: 68.78, lon: 32.75, population: 0.3, tier: 'regional' },
  { code: 'JSA', name: 'Jaisalmer', city: 'Jaisalmer', country: 'IN', lat: 26.89, lon: 70.86, population: 0.08, tier: 'regional', visitors: 0.7 },
  { code: 'URA', name: 'Uralsk Ak Zhol', city: 'Uralsk', country: 'KZ', lat: 51.15, lon: 51.54, population: 0.3, tier: 'regional' },
  { code: 'ZBR', name: 'Konarak Chabahar', city: 'Chabahar', country: 'IR', lat: 25.44, lon: 60.38, population: 0.1, tier: 'regional', visitors: 0.5 },
  { code: 'SOQ', name: 'Domine Eduard Osok', city: 'Sorong', country: 'ID', lat: -0.89, lon: 131.29, population: 0.25, tier: 'regional' },
  { code: 'BHH', name: 'Bisha', city: 'Bisha', country: 'SA', lat: 19.98, lon: 42.62, population: 0.2, tier: 'regional' },
  { code: 'BUW', name: 'Betoambari', city: 'Bau-Bau', country: 'ID', lat: -5.49, lon: 122.57, population: 0.16, tier: 'regional' },
  { code: 'TIM', name: 'Mozes Kilangin', city: 'Timika', country: 'ID', lat: -4.53, lon: 136.89, population: 0.3, tier: 'regional' },
  { code: 'DIG', name: 'Diqing Shangri-La', city: 'Shangri-La', country: 'CN', lat: 27.79, lon: 99.68, population: 0.15, tier: 'regional', visitors: 1 },
  { code: 'SZY', name: 'Olsztyn-Mazury', city: 'Olsztyn', country: 'PL', lat: 53.48, lon: 20.94, population: 0.17, tier: 'regional' },
  { code: 'STM', name: 'Santarem Maestro Wilson', city: 'Santarem', country: 'BR', lat: -2.42, lon: -54.79, population: 0.3, tier: 'regional' },
  { code: 'TTE', name: 'Sultan Babullah', city: 'Ternate', country: 'ID', lat: 0.83, lon: 127.38, population: 0.2, tier: 'regional' },
  { code: 'BVB', name: 'Atlas Brasil Cantanhede', city: 'Boa Vista', country: 'BR', lat: 2.84, lon: -60.69, population: 0.4, tier: 'regional' },
  { code: 'BCM', name: 'Bacau', city: 'Bacau', country: 'RO', lat: 46.52, lon: 26.91, population: 0.15, tier: 'regional' },
  { code: 'ZAD', name: 'Zadar', city: 'Zadar', country: 'HR', lat: 44.11, lon: 15.35, population: 0.13, tier: 'regional', visitors: 0.8 },
  { code: 'BUS', name: 'Batumi Intl', city: 'Batumi', country: 'GE', lat: 41.61, lon: 41.6, population: 0.16, tier: 'regional', visitors: 1 },
  { code: 'OUL', name: 'Oulu', city: 'Oulu', country: 'FI', lat: 64.93, lon: 25.37, population: 0.21, tier: 'regional' },
  { code: 'TMC', name: 'Tambolaka', city: 'Sumba', country: 'ID', lat: -9.41, lon: 119.24, population: 0.1, tier: 'regional', visitors: 0.4 },
  { code: 'SJI', name: 'San Jose Mindoro', city: 'San Jose', country: 'PH', lat: 12.36, lon: 121.05, population: 0.14, tier: 'regional' },
  { code: 'BJZ', name: 'Badajoz', city: 'Badajoz', country: 'ES', lat: 38.89, lon: -6.82, population: 0.15, tier: 'regional' },
  { code: 'KGT', name: 'Kangding', city: 'Kangding', country: 'CN', lat: 30.16, lon: 101.74, population: 0.13, tier: 'regional', visitors: 0.5 },
  { code: 'LAO', name: 'Laoag Intl', city: 'Laoag', country: 'PH', lat: 18.18, lon: 120.53, population: 0.1, tier: 'regional', visitors: 0.3 },
  { code: 'NJC', name: 'Nizhnevartovsk', city: 'Nizhnevartovsk', country: 'RU', lat: 60.95, lon: 76.48, population: 0.28, tier: 'regional' },
  { code: 'TEZ', name: 'Tezpur', city: 'Tezpur', country: 'IN', lat: 26.71, lon: 92.78, population: 0.1, tier: 'regional' },
  { code: 'PPK', name: 'Petropavl', city: 'Petropavl', country: 'KZ', lat: 54.77, lon: 69.18, population: 0.22, tier: 'regional' },
  { code: 'PYB', name: 'Jeypore', city: 'Jeypore', country: 'IN', lat: 18.88, lon: 82.55, population: 0.1, tier: 'regional' },
  { code: 'SUG', name: 'Surigao', city: 'Surigao', country: 'PH', lat: 9.76, lon: 125.48, population: 0.17, tier: 'regional' },
  { code: 'HEH', name: 'Heho', city: 'Heho', country: 'MM', lat: 20.75, lon: 96.79, population: 0.1, tier: 'regional', visitors: 0.6 },
  { code: 'GWD', name: 'Gwadar Intl', city: 'Gwadar', country: 'PK', lat: 25.23, lon: 62.33, population: 0.1, tier: 'regional' },
  { code: 'ETM', name: 'Ramon', city: 'Eilat', country: 'IL', lat: 30.78, lon: 35.01, population: 0.07, tier: 'regional', visitors: 1 },
  { code: 'KDU', name: 'Skardu Intl', city: 'Skardu', country: 'PK', lat: 35.34, lon: 75.54, population: 0.06, tier: 'regional', visitors: 0.6 },
  { code: 'TPP', name: 'Cadete Guevara', city: 'Tarapoto', country: 'PE', lat: -6.51, lon: -76.37, population: 0.2, tier: 'regional' },
  { code: 'DOL', name: 'Deauville-Normandie', city: 'Deauville', country: 'FR', lat: 49.36, lon: 0.15, population: 0.05, tier: 'regional', visitors: 0.5 },
  { code: 'RTG', name: 'Frans Sales Lega', city: 'Ruteng', country: 'ID', lat: -8.6, lon: 120.48, population: 0.1, tier: 'regional' },
  { code: 'KUT', name: 'Kutaisi David Agmashenebeli', city: 'Kutaisi', country: 'GE', lat: 42.18, lon: 42.48, population: 0.15, tier: 'regional' },
  { code: 'EGC', name: 'Bergerac Dordogne', city: 'Bergerac', country: 'FR', lat: 44.83, lon: 0.52, population: 0.06, tier: 'regional', visitors: 0.4 },
  { code: 'LUW', name: 'Syukuran Aminuddin', city: 'Luwuk', country: 'ID', lat: -1.04, lon: 122.77, population: 0.1, tier: 'regional' },
  { code: 'ABT', name: 'Al-Baha', city: 'Al-Baha', country: 'SA', lat: 20.3, lon: 41.63, population: 0.1, tier: 'regional', visitors: 0.3 },
  { code: 'WGP', name: 'Umbu Mehang Kunda', city: 'Waingapu', country: 'ID', lat: -9.67, lon: 120.3, population: 0.07, tier: 'regional', visitors: 0.3 },
  { code: 'MKQ', name: 'Mopah', city: 'Merauke', country: 'ID', lat: -8.52, lon: 140.42, population: 0.2, tier: 'regional' },
  { code: 'WAE', name: 'Wadi al-Dawasir', city: 'Wadi al-Dawasir', country: 'SA', lat: 20.5, lon: 45.2, population: 0.1, tier: 'regional' },
  { code: 'JZH', name: 'Jiuzhaigou Huanglong', city: 'Jiuzhaigou', country: 'CN', lat: 32.85, lon: 103.68, population: 0.08, tier: 'regional', visitors: 1.2 },
  { code: 'BRC', name: 'Bariloche', city: 'San Carlos de Bariloche', country: 'AR', lat: -41.15, lon: -71.16, population: 0.13, tier: 'regional', visitors: 1.2 },
  { code: 'PKZ', name: 'Pakse', city: 'Pakse', country: 'LA', lat: 15.13, lon: 105.78, population: 0.09, tier: 'regional' },
  { code: 'SHW', name: 'Sharurah', city: 'Sharurah', country: 'SA', lat: 17.47, lon: 47.12, population: 0.1, tier: 'regional' },
  { code: 'MBT', name: 'Moises Espinosa', city: 'Masbate', country: 'PH', lat: 12.37, lon: 123.63, population: 0.1, tier: 'regional' },
  { code: 'MKW', name: 'Rendani', city: 'Manokwari', country: 'ID', lat: -0.89, lon: 134.05, population: 0.15, tier: 'regional' },
  { code: 'OSI', name: 'Osijek', city: 'Osijek', country: 'HR', lat: 45.46, lon: 18.81, population: 0.1, tier: 'regional' },
  { code: 'CJL', name: 'Chitral', city: 'Chitral', country: 'PK', lat: 35.89, lon: 71.8, population: 0.05, tier: 'regional', visitors: 0.4 },
  { code: 'DIU', name: 'Diu', city: 'Diu', country: 'IN', lat: 20.71, lon: 70.92, population: 0.05, tier: 'regional', visitors: 0.5 },
  { code: 'HRI', name: 'Mattala Rajapaksa', city: 'Hambantota', country: 'LK', lat: 6.28, lon: 81.12, population: 0.1, tier: 'regional', visitors: 0.3 },
  { code: 'LBJ', name: 'Komodo', city: 'Labuan Bajo', country: 'ID', lat: -8.49, lon: 119.89, population: 0.06, tier: 'regional', visitors: 1 },
  { code: 'KUO', name: 'Kuopio', city: 'Kuopio', country: 'FI', lat: 63.01, lon: 27.8, population: 0.12, tier: 'regional' },
  { code: 'KIH', name: 'Kish Intl', city: 'Kish', country: 'IR', lat: 26.53, lon: 53.98, population: 0.04, tier: 'regional', visitors: 1 },
  { code: 'RDZ', name: 'Rodez Aveyron', city: 'Rodez', country: 'FR', lat: 44.41, lon: 2.48, population: 0.06, tier: 'regional' },
  { code: 'ULH', name: 'Prince Abdul Majeed AlUla', city: 'AlUla', country: 'SA', lat: 26.48, lon: 38, population: 0.06, tier: 'regional', visitors: 1 },
  { code: 'GDX', name: 'Sokol', city: 'Magadan', country: 'RU', lat: 59.91, lon: 150.72, population: 0.09, tier: 'regional' },
  { code: 'PLQ', name: 'Palanga', city: 'Palanga', country: 'LT', lat: 55.97, lon: 21.09, population: 0.07, tier: 'regional', visitors: 0.4 },
  { code: 'VXO', name: 'Vaxjo Smaland', city: 'Vaxjo', country: 'SE', lat: 56.93, lon: 14.73, population: 0.07, tier: 'regional' },
  { code: 'DIN', name: 'Dien Bien Phu', city: 'Dien Bien Phu', country: 'VN', lat: 21.39, lon: 103.01, population: 0.08, tier: 'regional' },
  { code: 'HAU', name: 'Haugesund Karmoy', city: 'Haugesund', country: 'NO', lat: 59.35, lon: 5.21, population: 0.06, tier: 'regional' },
  { code: 'BIK', name: 'Frans Kaisiepo', city: 'Biak', country: 'ID', lat: -1.19, lon: 136.11, population: 0.13, tier: 'regional' },
  { code: 'NYU', name: 'Nyaung U Bagan', city: 'Bagan', country: 'MM', lat: 21.18, lon: 94.93, population: 0.05, tier: 'regional', visitors: 0.8 },
  { code: 'KRW', name: 'Turkmenbashi', city: 'Turkmenbashi', country: 'TM', lat: 40.06, lon: 53.01, population: 0.07, tier: 'regional', visitors: 0.3 },
  { code: 'NAJ', name: 'Nakhchivan', city: 'Nakhchivan', country: 'AZ', lat: 39.19, lon: 45.46, population: 0.09, tier: 'regional' },
  { code: 'EJH', name: 'Al Wajh', city: 'Al Wajh', country: 'SA', lat: 26.2, lon: 36.48, population: 0.05, tier: 'regional', visitors: 0.3 },
  { code: 'ESL', name: 'Elista', city: 'Elista', country: 'RU', lat: 46.37, lon: 44.33, population: 0.1, tier: 'regional' },
  { code: 'LPX', name: 'Liepaja', city: 'Liepaja', country: 'LV', lat: 56.52, lon: 21.1, population: 0.07, tier: 'regional' },
  { code: 'TOS', name: 'Tromso', city: 'Tromso', country: 'NO', lat: 69.68, lon: 18.92, population: 0.08, tier: 'regional', visitors: 0.6 },
  { code: 'DQM', name: 'Duqm Intl', city: 'Duqm', country: 'OM', lat: 19.5, lon: 57.63, population: 0.05, tier: 'regional' },
  { code: 'PUQ', name: 'Pdte Carlos Ibanez', city: 'Punta Arenas', country: 'CL', lat: -53, lon: -70.85, population: 0.13, tier: 'regional', visitors: 0.6 },
  { code: 'ZER', name: 'Ziro', city: 'Ziro', country: 'IN', lat: 27.59, lon: 93.83, population: 0.05, tier: 'regional' },
  { code: 'USU', name: 'Francisco Reyes', city: 'Coron', country: 'PH', lat: 12.12, lon: 120.1, population: 0.05, tier: 'regional', visitors: 0.8 },
  { code: 'LLA', name: 'Lulea', city: 'Lulea', country: 'SE', lat: 65.54, lon: 22.12, population: 0.08, tier: 'regional' },
  { code: 'NBX', name: 'Douw Aturure', city: 'Nabire', country: 'ID', lat: -3.37, lon: 135.5, population: 0.1, tier: 'regional' },
  { code: 'PVK', name: 'Aktion Preveza', city: 'Preveza', country: 'GR', lat: 38.93, lon: 20.77, population: 0.05, tier: 'regional', visitors: 0.7 },
  { code: 'TAT', name: 'Poprad-Tatry', city: 'Poprad', country: 'SK', lat: 49.07, lon: 20.24, population: 0.05, tier: 'regional', visitors: 0.6 },
  { code: 'KJI', name: 'Kanas', city: 'Burqin', country: 'CN', lat: 48.22, lon: 86.99, population: 0.06, tier: 'regional', visitors: 0.6 },
  { code: 'JOE', name: 'Joensuu', city: 'Joensuu', country: 'FI', lat: 62.66, lon: 29.61, population: 0.08, tier: 'regional' },
  { code: 'OSD', name: 'Ostersund Are', city: 'Ostersund', country: 'SE', lat: 63.19, lon: 14.5, population: 0.05, tier: 'regional', visitors: 0.5 },
  { code: 'KSU', name: 'Kristiansund Kvernberget', city: 'Kristiansund', country: 'NO', lat: 63.11, lon: 7.82, population: 0.05, tier: 'regional' },
  { code: 'SPC', name: 'La Palma', city: 'Santa Cruz de la Palma', country: 'ES', lat: 28.63, lon: -17.76, population: 0.08, tier: 'regional', visitors: 0.4 },
  { code: 'NUX', name: 'Novy Urengoy', city: 'Novy Urengoy', country: 'RU', lat: 66.07, lon: 76.52, population: 0.12, tier: 'regional' },
  { code: 'RVN', name: 'Rovaniemi', city: 'Rovaniemi', country: 'FI', lat: 66.56, lon: 25.83, population: 0.06, tier: 'regional', visitors: 1 },
  { code: 'ADZ', name: 'Gustavo Rojas Pinilla', city: 'San Andres', country: 'CO', lat: 12.58, lon: -81.71, population: 0.06, tier: 'regional', visitors: 1 },
  { code: 'ZTH', name: 'Zakynthos', city: 'Zakynthos', country: 'GR', lat: 37.75, lon: 20.88, population: 0.04, tier: 'regional', visitors: 1 },
  { code: 'EFL', name: 'Kefalonia', city: 'Kefalonia', country: 'GR', lat: 38.12, lon: 20.5, population: 0.04, tier: 'regional', visitors: 0.6 },
  { code: 'AUR', name: 'Aurillac', city: 'Aurillac', country: 'FR', lat: 44.9, lon: 2.42, population: 0.03, tier: 'regional' },
  { code: 'BOO', name: 'Bodo', city: 'Bodo', country: 'NO', lat: 67.27, lon: 14.37, population: 0.05, tier: 'regional' },
  { code: 'TER', name: 'Lajes', city: 'Terceira', country: 'PT', lat: 38.76, lon: -27.09, population: 0.05, tier: 'regional', visitors: 0.4 },
  { code: 'VBY', name: 'Visby', city: 'Visby', country: 'SE', lat: 57.66, lon: 18.35, population: 0.03, tier: 'regional', visitors: 0.6 },
  { code: 'EVE', name: 'Harstad Narvik', city: 'Harstad', country: 'NO', lat: 68.49, lon: 16.68, population: 0.04, tier: 'regional' },
  { code: 'FKQ', name: 'Fakfak Torea', city: 'Fakfak', country: 'ID', lat: -2.92, lon: 132.27, population: 0.04, tier: 'regional' },
  { code: 'AEY', name: 'Akureyri', city: 'Akureyri', country: 'IS', lat: 65.66, lon: 18.07, population: 0.02, tier: 'regional', visitors: 0.4 },
  { code: 'NYM', name: 'Nadym', city: 'Nadym', country: 'RU', lat: 65.48, lon: 72.7, population: 0.045, tier: 'regional' },
  { code: 'KRN', name: 'Kiruna', city: 'Kiruna', country: 'SE', lat: 67.82, lon: 20.34, population: 0.02, tier: 'regional', visitors: 0.4 },
  { code: 'FTE', name: 'El Calafate', city: 'El Calafate', country: 'AR', lat: -50.28, lon: -72.05, population: 0.03, tier: 'regional', visitors: 1 },
  { code: 'ALF', name: 'Alta', city: 'Alta', country: 'NO', lat: 69.98, lon: 23.37, population: 0.02, tier: 'regional', visitors: 0.4 },
  { code: 'AOK', name: 'Karpathos', city: 'Karpathos', country: 'GR', lat: 35.42, lon: 27.15, population: 0.01, tier: 'regional', visitors: 0.5 },
  { code: 'JSI', name: 'Skiathos', city: 'Skiathos', country: 'GR', lat: 39.18, lon: 23.5, population: 0.01, tier: 'regional', visitors: 0.8 },
  { code: 'AGX', name: 'Agatti', city: 'Agatti', country: 'IN', lat: 10.82, lon: 72.18, population: 0.01, tier: 'regional', visitors: 0.5 },
  { code: 'DYR', name: 'Ugolny', city: 'Anadyr', country: 'RU', lat: 64.73, lon: 177.74, population: 0.015, tier: 'regional' },
  { code: 'IVL', name: 'Ivalo', city: 'Ivalo', country: 'FI', lat: 68.61, lon: 27.41, population: 0.01, tier: 'regional', visitors: 0.5 },
  { code: 'KKN', name: 'Kirkenes Hoybuktmoen', city: 'Kirkenes', country: 'NO', lat: 69.73, lon: 29.89, population: 0.01, tier: 'regional', visitors: 0.3 },
  { code: 'HOR', name: 'Horta', city: 'Horta', country: 'PT', lat: 38.52, lon: -28.72, population: 0.01, tier: 'regional', visitors: 0.3 },
  { code: 'MLO', name: 'Milos', city: 'Milos', country: 'GR', lat: 36.7, lon: 24.48, population: 0.005, tier: 'regional', visitors: 0.5 },

  // ══════════════════════════════════════════════════════════════════════════
  // EXPANSION WAVE (2026-06-17) — 207 airports added via tools/airport-expansion
  // (tiered scorer: distinct + viable against the live gravity model)
  // ══════════════════════════════════════════════════════════════════════════
  // ── AF ──
  { code: 'KDH', name: 'Kandahar Intl', city: 'Kandahar', country: 'AF', lat: 31.51, lon: 65.85, population: 0.6, tier: 'regional' },
  // ── AO ──
  { code: 'NOV', name: 'Albano Machado', city: 'Huambo', country: 'AO', lat: -12.81, lon: 15.76, population: 0.9, tier: 'regional' },
  { code: 'BUG', name: 'Benguela', city: 'Benguela', country: 'AO', lat: -12.61, lon: 13.4, population: 0.6, tier: 'regional' },
  // ── AR ──
  { code: 'ROS', name: 'Islas Malvinas', city: 'Rosario', country: 'AR', lat: -32.9, lon: -60.78, population: 1.3, tier: 'regional' },
  { code: 'TUC', name: 'Teniente Benjamin Matienzo', city: 'Tucuman', country: 'AR', lat: -26.84, lon: -65.1, population: 0.9, tier: 'regional' },
  { code: 'MDQ', name: 'Astor Piazzolla', city: 'Mar del Plata', country: 'AR', lat: -37.93, lon: -57.57, population: 0.6, visitors: 0.3, tier: 'regional' },
  { code: 'CNQ', name: 'Camba Punta', city: 'Corrientes', country: 'AR', lat: -27.45, lon: -58.76, population: 0.4, tier: 'regional' },
  { code: 'RES', name: 'Resistencia Intl', city: 'Resistencia', country: 'AR', lat: -27.45, lon: -59.06, population: 0.4, tier: 'regional' },
  { code: 'PSS', name: 'Libertador San Martin', city: 'Posadas', country: 'AR', lat: -27.39, lon: -55.97, population: 0.35, tier: 'regional' },
  { code: 'BHI', name: 'Comandante Espora', city: 'Bahia Blanca', country: 'AR', lat: -38.72, lon: -62.17, population: 0.3, tier: 'regional' },
  { code: 'JUJ', name: 'Gobernador Horacio Guzman', city: 'Jujuy', country: 'AR', lat: -24.39, lon: -65.1, population: 0.3, tier: 'regional' },
  { code: 'CRD', name: 'Gen. E. Mosconi', city: 'Comodoro Rivadavia', country: 'AR', lat: -45.78, lon: -67.47, population: 0.2, tier: 'regional' },
  { code: 'REL', name: 'Almirante Zar', city: 'Trelew', country: 'AR', lat: -43.21, lon: -65.27, population: 0.1, visitors: 0.6, tier: 'regional' },
  { code: 'RGL', name: 'Piloto Civil N. Fernandez', city: 'Rio Gallegos', country: 'AR', lat: -51.61, lon: -69.31, population: 0.1, tier: 'regional' },
  // ── AU ──
  { code: 'NTL', name: 'Newcastle', city: 'Newcastle', country: 'AU', lat: -32.79, lon: 151.83, population: 0.5, tier: 'regional' },
  { code: 'ASP', name: 'Alice Springs', city: 'Alice Springs', country: 'AU', lat: -23.81, lon: 133.9, population: 0.03, visitors: 0.6, tier: 'regional' },
  { code: 'BME', name: 'Broome Intl', city: 'Broome', country: 'AU', lat: -17.95, lon: 122.23, population: 0.02, visitors: 0.6, tier: 'regional' },
  // ── BA ──
  { code: 'TZL', name: 'Tuzla Intl', city: 'Tuzla', country: 'BA', lat: 44.46, lon: 18.72, population: 0.12, tier: 'regional' },
  // ── BF ──
  { code: 'BOY', name: 'Bobo Dioulasso', city: 'Bobo-Dioulasso', country: 'BF', lat: 11.16, lon: -4.33, population: 1, tier: 'regional' },
  // ── BO ──
  { code: 'SRE', name: 'Juana Azurduy', city: 'Sucre', country: 'BO', lat: -19.01, lon: -65.29, population: 0.3, tier: 'regional' },
  { code: 'UYU', name: 'Joya Andina', city: 'Uyuni', country: 'BO', lat: -20.45, lon: -66.85, population: 0.03, visitors: 0.6, tier: 'regional' },
  // ── BR ──
  { code: 'CXJ', name: 'Hugo Cantergiani', city: 'Caxias do Sul', country: 'BR', lat: -29.2, lon: -51.19, population: 0.51, tier: 'regional' },
  { code: 'SJP', name: 'Prof. Eribelto Manoel Reino', city: 'Sao Jose do Rio Preto', country: 'BR', lat: -20.82, lon: -49.4, population: 0.5, tier: 'regional' },
  { code: 'CPV', name: 'Joao Suassuna', city: 'Campina Grande', country: 'BR', lat: -7.27, lon: -35.9, population: 0.42, tier: 'regional' },
  { code: 'MOC', name: 'Mario Ribeiro', city: 'Montes Claros', country: 'BR', lat: -16.71, lon: -43.82, population: 0.41, tier: 'regional' },
  { code: 'VDC', name: 'Glauber Rocha', city: 'Vitoria da Conquista', country: 'BR', lat: -14.86, lon: -40.86, population: 0.34, tier: 'regional' },
  { code: 'CAC', name: 'Coronel Adalberto Mendes', city: 'Cascavel', country: 'BR', lat: -25, lon: -53.5, population: 0.33, tier: 'regional' },
  { code: 'IPN', name: 'Usiminas', city: 'Ipatinga', country: 'BR', lat: -19.47, lon: -42.49, population: 0.3, tier: 'regional' },
  { code: 'IMP', name: 'Prefeito Renato Moreira', city: 'Imperatriz', country: 'BR', lat: -5.53, lon: -47.46, population: 0.26, tier: 'regional' },
  { code: 'CFB', name: 'Cabo Frio Intl', city: 'Cabo Frio', country: 'BR', lat: -22.92, lon: -42.07, population: 0.23, visitors: 0.6, tier: 'regional' },
  { code: 'OPS', name: 'Presidente Joao Figueiredo', city: 'Sinop', country: 'BR', lat: -11.88, lon: -55.59, population: 0.14, tier: 'regional' },
  { code: 'CZS', name: 'Cruzeiro do Sul', city: 'Cruzeiro do Sul', country: 'BR', lat: -7.6, lon: -72.77, population: 0.09, tier: 'regional' },
  { code: 'TBT', name: 'Tabatinga', city: 'Tabatinga', country: 'BR', lat: -4.25, lon: -69.94, population: 0.06, tier: 'regional' },
  { code: 'FEN', name: 'Fernando de Noronha', city: 'Fernando de Noronha', country: 'BR', lat: -3.85, lon: -32.42, population: 0.003, visitors: 0.6, tier: 'regional' },
  // ── BS ──
  { code: 'FPO', name: 'Grand Bahama Intl', city: 'Freeport', country: 'BS', lat: 26.56, lon: -78.7, population: 0.05, visitors: 0.6, tier: 'regional' },
  // ── CD ──
  { code: 'FBM', name: 'Lubumbashi Intl', city: 'Lubumbashi', country: 'CD', lat: -11.59, lon: 27.53, population: 2.6, tier: 'regional' },
  { code: 'MJM', name: 'Mbuji-Mayi', city: 'Mbuji-Mayi', country: 'CD', lat: -6.12, lon: 23.57, population: 2.5, tier: 'regional' },
  { code: 'KGA', name: 'Kananga', city: 'Kananga', country: 'CD', lat: -5.9, lon: 22.47, population: 1.5, tier: 'regional' },
  { code: 'FKI', name: 'Kisangani Bangoka', city: 'Kisangani', country: 'CD', lat: 0.49, lon: 25.34, population: 1.2, tier: 'regional' },
  { code: 'GOM', name: 'Goma Intl', city: 'Goma', country: 'CD', lat: -1.67, lon: 29.24, population: 0.7, tier: 'regional' },
  // ── CL ──
  { code: 'LSC', name: 'La Florida', city: 'La Serena', country: 'CL', lat: -29.92, lon: -71.2, population: 0.4, visitors: 0.6, tier: 'regional' },
  { code: 'ARI', name: 'Chacalluta', city: 'Arica', country: 'CL', lat: -18.35, lon: -70.34, population: 0.25, tier: 'regional' },
  { code: 'ZAL', name: 'Pichoy', city: 'Valdivia', country: 'CL', lat: -39.65, lon: -73.09, population: 0.18, tier: 'regional' },
  { code: 'BBA', name: 'Balmaceda', city: 'Balmaceda', country: 'CL', lat: -45.92, lon: -71.69, population: 0.06, visitors: 0.6, tier: 'regional' },
  // ── CM ──
  { code: 'GOU', name: 'Garoua Intl', city: 'Garoua', country: 'CM', lat: 9.34, lon: 13.37, population: 0.6, tier: 'regional' },
  { code: 'MVR', name: 'Salak', city: 'Maroua', country: 'CM', lat: 10.45, lon: 14.26, population: 0.4, tier: 'regional' },
  // ── CN ──
  { code: 'JJN', name: 'Jinjiang Intl', city: 'Quanzhou', country: 'CN', lat: 24.8, lon: 118.59, population: 8.7, tier: 'major' },
  { code: 'HNY', name: 'Nanyue', city: 'Hengyang', country: 'CN', lat: 26.91, lon: 112.62, population: 6.6, tier: 'major' },
  { code: 'CZX', name: 'Benniu Intl', city: 'Changzhou', country: 'CN', lat: 31.92, lon: 119.78, population: 5.3, tier: 'regional' },
  { code: 'JIU', name: 'Lushan', city: 'Jiujiang', country: 'CN', lat: 29.48, lon: 115.8, population: 4.6, visitors: 0.3, tier: 'regional' },
  { code: 'AQG', name: 'Tianzhushan', city: 'Anqing', country: 'CN', lat: 30.58, lon: 117.05, population: 4.2, tier: 'regional' },
  { code: 'WHA', name: 'Wuhu Xuanzhou', city: 'Wuhu', country: 'CN', lat: 31.39, lon: 118.41, population: 3.6, tier: 'regional' },
  { code: 'AOG', name: 'Tengao', city: 'Anshan', country: 'CN', lat: 41.1, lon: 122.85, population: 3.3, tier: 'regional' },
  { code: 'WEH', name: 'Dashuibo', city: 'Weihai', country: 'CN', lat: 37.19, lon: 122.23, population: 2.9, visitors: 0.3, tier: 'regional' },
  { code: 'WUT', name: 'Wutaishan', city: 'Xinzhou', country: 'CN', lat: 38.6, lon: 112.97, population: 2.7, visitors: 0.3, tier: 'regional' },
  { code: 'LNJ', name: 'Boshang', city: 'Lincang', country: 'CN', lat: 23.74, lon: 100.03, population: 2.3, tier: 'regional' },
  { code: 'KJH', name: 'Huangping', city: 'Kaili', country: 'CN', lat: 26.97, lon: 107.99, population: 1.3, tier: 'regional' },
  { code: 'HSN', name: 'Putuoshan', city: 'Zhoushan', country: 'CN', lat: 29.93, lon: 122.36, population: 1.2, visitors: 0.3, tier: 'regional' },
  // ── CO ──
  { code: 'VVC', name: 'La Vanguardia', city: 'Villavicencio', country: 'CO', lat: 4.17, lon: -73.61, population: 0.55, tier: 'regional' },
  { code: 'IBE', name: 'Perales', city: 'Ibague', country: 'CO', lat: 4.42, lon: -75.13, population: 0.53, tier: 'regional' },
  { code: 'MTR', name: 'Los Garzones', city: 'Monteria', country: 'CO', lat: 8.82, lon: -75.83, population: 0.49, tier: 'regional' },
  { code: 'VUP', name: 'Alfonso Lopez Pumarejo', city: 'Valledupar', country: 'CO', lat: 10.44, lon: -73.25, population: 0.49, tier: 'regional' },
  { code: 'NVA', name: 'Benito Salas', city: 'Neiva', country: 'CO', lat: 2.95, lon: -75.29, population: 0.36, tier: 'regional' },
  { code: 'PSO', name: 'Antonio Narino', city: 'Pasto', country: 'CO', lat: 1.4, lon: -77.29, population: 0.35, tier: 'regional' },
  { code: 'PPN', name: 'Guillermo Leon Valencia', city: 'Popayan', country: 'CO', lat: 2.45, lon: -76.61, population: 0.32, tier: 'regional' },
  { code: 'LET', name: 'Alfredo Vasquez Cobo', city: 'Leticia', country: 'CO', lat: -4.19, lon: -69.94, population: 0.05, visitors: 0.6, tier: 'regional' },
  // ── CU ──
  { code: 'SCU', name: 'Antonio Maceo', city: 'Santiago de Cuba', country: 'CU', lat: 19.97, lon: -75.84, population: 0.5, tier: 'regional' },
  { code: 'HOG', name: 'Frank Pais', city: 'Holguin', country: 'CU', lat: 20.79, lon: -76.32, population: 0.35, tier: 'regional' },
  { code: 'VRA', name: 'Juan Gualberto Gomez', city: 'Varadero', country: 'CU', lat: 23.03, lon: -81.44, population: 0.04, visitors: 0.6, tier: 'regional' },
  // ── CV ──
  { code: 'BVC', name: 'Aristides Pereira Intl', city: 'Boa Vista', country: 'CV', lat: 16.14, lon: -22.89, population: 0.02, visitors: 0.6, tier: 'regional' },
  // ── DZ ──
  { code: 'AAE', name: 'Rabah Bitat', city: 'Annaba', country: 'DZ', lat: 36.82, lon: 7.81, population: 0.6, tier: 'regional' },
  { code: 'GHA', name: 'Noumerat', city: 'Ghardaia', country: 'DZ', lat: 32.38, lon: 3.79, population: 0.4, tier: 'regional' },
  { code: 'TMR', name: 'Aguenar', city: 'Tamanrasset', country: 'DZ', lat: 22.81, lon: 5.45, population: 0.1, visitors: 0.6, tier: 'regional' },
  // ── EC ──
  { code: 'MEC', name: 'Eloy Alfaro', city: 'Manta', country: 'EC', lat: -0.95, lon: -80.68, population: 0.26, visitors: 0.6, tier: 'regional' },
  { code: 'GPS', name: 'Seymour', city: 'Galapagos', country: 'EC', lat: -0.45, lon: -90.27, population: 0.03, visitors: 0.6, tier: 'regional' },
  // ── EG ──
  { code: 'LXR', name: 'Luxor Intl', city: 'Luxor', country: 'EG', lat: 25.67, lon: 32.71, population: 0.5, visitors: 0.3, tier: 'regional' },
  { code: 'ASW', name: 'Aswan Intl', city: 'Aswan', country: 'EG', lat: 23.96, lon: 32.82, population: 0.3, visitors: 0.6, tier: 'regional' },
  { code: 'RMF', name: 'Marsa Alam Intl', city: 'Marsa Alam', country: 'EG', lat: 25.56, lon: 34.58, population: 0.05, visitors: 0.6, tier: 'regional' },
  // ── ET ──
  { code: 'MQX', name: 'Alula Aba Nega', city: 'Mekelle', country: 'ET', lat: 13.47, lon: 39.53, population: 0.5, tier: 'regional' },
  { code: 'DIR', name: 'Aba Tenna Dejazmach', city: 'Dire Dawa', country: 'ET', lat: 9.62, lon: 41.85, population: 0.5, tier: 'regional' },
  { code: 'GDQ', name: 'Gondar', city: 'Gondar', country: 'ET', lat: 12.52, lon: 37.43, population: 0.4, visitors: 0.6, tier: 'regional' },
  { code: 'BJR', name: 'Bahir Dar', city: 'Bahir Dar', country: 'ET', lat: 11.61, lon: 37.32, population: 0.4, tier: 'regional' },
  { code: 'JIM', name: 'Aba Segud', city: 'Jimma', country: 'ET', lat: 7.66, lon: 36.82, population: 0.2, tier: 'regional' },
  { code: 'AXU', name: 'Axum', city: 'Axum', country: 'ET', lat: 14.15, lon: 38.77, population: 0.07, visitors: 0.6, tier: 'regional' },
  { code: 'LLI', name: 'Lalibela', city: 'Lalibela', country: 'ET', lat: 11.98, lon: 38.98, population: 0.03, visitors: 0.6, tier: 'regional' },
  // ── GA ──
  { code: 'POG', name: 'Port-Gentil', city: 'Port-Gentil', country: 'GA', lat: -0.71, lon: 8.75, population: 0.15, tier: 'regional' },
  // ── GH ──
  { code: 'KMS', name: 'Kumasi', city: 'Kumasi', country: 'GH', lat: 6.71, lon: -1.59, population: 2.6, tier: 'regional' },
  { code: 'TML', name: 'Tamale', city: 'Tamale', country: 'GH', lat: 9.56, lon: -0.86, population: 0.6, tier: 'regional' },
  // ── GR ──
  { code: 'MJT', name: 'Mytilene', city: 'Lesvos', country: 'GR', lat: 39.05, lon: 26.6, population: 0.09, visitors: 0.6, tier: 'regional' },
  // ── GT ──
  { code: 'FRS', name: 'Mundo Maya', city: 'Flores', country: 'GT', lat: 16.91, lon: -89.87, population: 0.06, visitors: 0.6, tier: 'regional' },
  // ── ID ──
  { code: 'MLG', name: 'Abdul Rachman Saleh', city: 'Malang', country: 'ID', lat: -7.93, lon: 112.71, population: 0.9, visitors: 0.3, tier: 'regional' },
  { code: 'AAP', name: 'APT Pranoto', city: 'Samarinda', country: 'ID', lat: -0.37, lon: 117.25, population: 0.85, tier: 'regional' },
  { code: 'CBN', name: 'Kertajati', city: 'Cirebon', country: 'ID', lat: -6.76, lon: 108.54, population: 0.4, tier: 'regional' },
  { code: 'BWX', name: 'Banyuwangi', city: 'Banyuwangi', country: 'ID', lat: -8.31, lon: 114.34, population: 0.3, visitors: 0.6, tier: 'regional' },
  { code: 'MJU', name: 'Tampa Padang', city: 'Mamuju', country: 'ID', lat: -2.58, lon: 119.03, population: 0.3, tier: 'regional' },
  { code: 'TRK', name: 'Juwata', city: 'Tarakan', country: 'ID', lat: 3.33, lon: 117.57, population: 0.24, tier: 'regional' },
  { code: 'BMU', name: 'Sultan M. Salahuddin', city: 'Bima', country: 'ID', lat: -8.54, lon: 118.69, population: 0.15, tier: 'regional' },
  { code: 'GNS', name: 'Binaka', city: 'Gunungsitoli', country: 'ID', lat: 1.17, lon: 97.7, population: 0.13, visitors: 0.6, tier: 'regional' },
  { code: 'BEJ', name: 'Kalimarau', city: 'Berau', country: 'ID', lat: 2.16, lon: 117.43, population: 0.13, visitors: 0.6, tier: 'regional' },
  { code: 'WMX', name: 'Wamena', city: 'Wamena', country: 'ID', lat: -4.1, lon: 138.95, population: 0.1, tier: 'regional' },
  { code: 'ENE', name: 'H. Hasan Aroeboesman', city: 'Ende', country: 'ID', lat: -8.85, lon: 121.66, population: 0.09, tier: 'regional' },
  // ── IN ──
  { code: 'KNU', name: 'Chakeri', city: 'Kanpur', country: 'IN', lat: 26.4, lon: 80.41, population: 3.1, tier: 'regional' },
  { code: 'LUH', name: 'Sahnewal', city: 'Ludhiana', country: 'IN', lat: 30.85, lon: 75.95, population: 1.7, tier: 'regional' },
  { code: 'JGA', name: 'Jamnagar', city: 'Jamnagar', country: 'IN', lat: 22.46, lon: 70.01, population: 0.7, tier: 'regional' },
  { code: 'PNY', name: 'Pondicherry', city: 'Puducherry', country: 'IN', lat: 11.97, lon: 79.81, population: 0.65, visitors: 0.3, tier: 'regional' },
  { code: 'KQH', name: 'Kishangarh', city: 'Ajmer', country: 'IN', lat: 26.59, lon: 74.81, population: 0.6, tier: 'regional' },
  { code: 'IXG', name: 'Belagavi', city: 'Belgaum', country: 'IN', lat: 15.86, lon: 74.62, population: 0.6, tier: 'regional' },
  { code: 'SHL', name: 'Shillong', city: 'Shillong', country: 'IN', lat: 25.7, lon: 91.98, population: 0.5, visitors: 0.3, tier: 'regional' },
  { code: 'IXA', name: 'Agartala', city: 'Agartala', country: 'IN', lat: 23.89, lon: 91.24, population: 0.5, tier: 'regional' },
  { code: 'DGH', name: 'Deoghar', city: 'Deoghar', country: 'IN', lat: 24.4, lon: 86.71, population: 0.2, visitors: 0.6, tier: 'regional' },
  { code: 'AYJ', name: 'Maharishi Valmiki', city: 'Ayodhya', country: 'IN', lat: 26.72, lon: 82.15, population: 0.06, visitors: 0.6, tier: 'regional' },
  { code: 'HJR', name: 'Khajuraho', city: 'Khajuraho', country: 'IN', lat: 24.81, lon: 79.92, population: 0.05, visitors: 0.6, tier: 'regional' },
  // ── IR ──
  { code: 'AZD', name: 'Shahid Sadooghi', city: 'Yazd', country: 'IR', lat: 31.9, lon: 54.28, population: 0.6, tier: 'regional' },
  // ── JP ──
  { code: 'AKJ', name: 'Asahikawa', city: 'Asahikawa', country: 'JP', lat: 43.67, lon: 142.45, population: 0.33, visitors: 0.6, tier: 'regional' },
  // ── KE ──
  { code: 'ELD', name: 'Eldoret Intl', city: 'Eldoret', country: 'KE', lat: 0.4, lon: 35.24, population: 0.4, tier: 'regional' },
  // ── KH ──
  { code: 'KOS', name: 'Sihanoukville Intl', city: 'Sihanoukville', country: 'KH', lat: 10.58, lon: 103.64, population: 0.15, visitors: 0.6, tier: 'regional' },
  // ── KZ ──
  { code: 'DMB', name: 'Taraz', city: 'Taraz', country: 'KZ', lat: 42.85, lon: 71.3, population: 0.36, tier: 'regional' },
  // ── LY ──
  { code: 'BEN', name: 'Benina Intl', city: 'Benghazi', country: 'LY', lat: 32.1, lon: 20.27, population: 0.8, tier: 'regional' },
  { code: 'MRA', name: 'Misrata Intl', city: 'Misrata', country: 'LY', lat: 32.33, lon: 15.06, population: 0.4, tier: 'regional' },
  // ── MA ──
  { code: 'FEZ', name: 'Fes-Saiss', city: 'Fes', country: 'MA', lat: 33.93, lon: -4.98, population: 1.1, visitors: 0.3, tier: 'regional' },
  { code: 'AGA', name: 'Al Massira', city: 'Agadir', country: 'MA', lat: 30.32, lon: -9.41, population: 0.6, visitors: 0.3, tier: 'regional' },
  { code: 'OUD', name: 'Angads', city: 'Oujda', country: 'MA', lat: 34.79, lon: -1.92, population: 0.5, tier: 'regional' },
  { code: 'EUN', name: 'Hassan I', city: 'Laayoune', country: 'MA', lat: 27.15, lon: -13.22, population: 0.2, tier: 'regional' },
  { code: 'VIL', name: 'Dakhla', city: 'Dakhla', country: 'MA', lat: 23.72, lon: -15.93, population: 0.1, visitors: 0.6, tier: 'regional' },
  { code: 'ESU', name: 'Mogador', city: 'Essaouira', country: 'MA', lat: 31.4, lon: -9.68, population: 0.08, visitors: 0.6, tier: 'regional' },
  // ── MG ──
  { code: 'TMM', name: 'Toamasina', city: 'Toamasina', country: 'MG', lat: -18.11, lon: 49.39, population: 0.3, tier: 'regional' },
  { code: 'MJN', name: 'Amborovy', city: 'Mahajanga', country: 'MG', lat: -15.67, lon: 46.35, population: 0.25, tier: 'regional' },
  { code: 'DIE', name: 'Arrachart', city: 'Antsiranana', country: 'MG', lat: -12.35, lon: 49.29, population: 0.1, tier: 'regional' },
  { code: 'NOS', name: 'Fascene', city: 'Nosy Be', country: 'MG', lat: -13.31, lon: 48.31, population: 0.08, visitors: 0.6, tier: 'regional' },
  { code: 'FTU', name: 'Tolagnaro', city: 'Fort Dauphin', country: 'MG', lat: -25.04, lon: 46.96, population: 0.07, visitors: 0.6, tier: 'regional' },
  // ── MK ──
  { code: 'OHD', name: 'Ohrid St Paul', city: 'Ohrid', country: 'MK', lat: 41.18, lon: 20.74, population: 0.05, visitors: 0.6, tier: 'regional' },
  // ── MM ──
  { code: 'AKY', name: 'Sittwe', city: 'Sittwe', country: 'MM', lat: 20.13, lon: 92.87, population: 0.18, tier: 'regional' },
  // ── MP ──
  { code: 'SPN', name: 'Saipan Intl', city: 'Saipan', country: 'MP', lat: 15.12, lon: 145.73, population: 0.05, visitors: 0.6, tier: 'regional' },
  // ── MV ──
  { code: 'GAN', name: 'Gan Intl', city: 'Gan', country: 'MV', lat: -0.69, lon: 73.16, population: 0.02, visitors: 0.6, tier: 'regional' },
  // ── MW ──
  { code: 'BLZ', name: 'Chileka Intl', city: 'Blantyre', country: 'MW', lat: -15.68, lon: 34.97, population: 0.8, tier: 'regional' },
  // ── MX ──
  { code: 'PBC', name: 'Hermanos Serdan', city: 'Puebla', country: 'MX', lat: 19.16, lon: -98.37, population: 3.2, tier: 'regional' },
  { code: 'TAM', name: 'Gen. Francisco J. Mina', city: 'Tampico', country: 'MX', lat: 22.29, lon: -97.87, population: 0.9, tier: 'regional' },
  { code: 'TPQ', name: 'Amado Nervo', city: 'Tepic', country: 'MX', lat: 21.42, lon: -104.84, population: 0.4, tier: 'regional' },
  { code: 'LMM', name: 'Valle del Fuerte', city: 'Los Mochis', country: 'MX', lat: 25.69, lon: -109.08, population: 0.4, tier: 'regional' },
  { code: 'CEN', name: 'Ciudad Obregon', city: 'Ciudad Obregon', country: 'MX', lat: 27.39, lon: -109.83, population: 0.4, tier: 'regional' },
  { code: 'CTM', name: 'Chetumal Intl', city: 'Chetumal', country: 'MX', lat: 18.5, lon: -88.33, population: 0.17, tier: 'regional' },
  { code: 'PXM', name: 'Puerto Escondido', city: 'Puerto Escondido', country: 'MX', lat: 15.87, lon: -97.09, population: 0.05, visitors: 0.6, tier: 'regional' },
  // ── MZ ──
  { code: 'APL', name: 'Nampula', city: 'Nampula', country: 'MZ', lat: -15.11, lon: 39.28, population: 0.7, tier: 'regional' },
  { code: 'BEW', name: 'Beira', city: 'Beira', country: 'MZ', lat: -19.8, lon: 34.91, population: 0.5, tier: 'regional' },
  { code: 'UEL', name: 'Quelimane', city: 'Quelimane', country: 'MZ', lat: -17.86, lon: 36.87, population: 0.3, tier: 'regional' },
  { code: 'POL', name: 'Pemba', city: 'Pemba', country: 'MZ', lat: -12.99, lon: 40.52, population: 0.2, visitors: 0.6, tier: 'regional' },
  { code: 'INH', name: 'Inhambane', city: 'Inhambane', country: 'MZ', lat: -23.88, lon: 35.41, population: 0.08, visitors: 0.6, tier: 'regional' },
  // ── NA ──
  { code: 'WVB', name: 'Walvis Bay', city: 'Walvis Bay', country: 'NA', lat: -22.98, lon: 14.65, population: 0.1, visitors: 0.6, tier: 'regional' },
  // ── NG ──
  { code: 'BNI', name: 'Benin', city: 'Benin City', country: 'NG', lat: 6.32, lon: 5.6, population: 1.7, tier: 'regional' },
  { code: 'KAD', name: 'Kaduna Intl', city: 'Kaduna', country: 'NG', lat: 10.7, lon: 7.32, population: 1.6, tier: 'regional' },
  { code: 'QOW', name: 'Sam Mbakwe', city: 'Owerri', country: 'NG', lat: 5.43, lon: 7.21, population: 0.9, tier: 'regional' },
  // ── NZ ──
  { code: 'HLZ', name: 'Hamilton', city: 'Hamilton', country: 'NZ', lat: -37.87, lon: 175.33, population: 0.18, tier: 'regional' },
  { code: 'DUD', name: 'Dunedin', city: 'Dunedin', country: 'NZ', lat: -45.93, lon: 170.2, population: 0.13, tier: 'regional' },
  { code: 'NPE', name: 'Hawke\'s Bay', city: 'Napier', country: 'NZ', lat: -39.47, lon: 176.87, population: 0.07, tier: 'regional' },
  // ── OM ──
  { code: 'SOH', name: 'Sohar', city: 'Sohar', country: 'OM', lat: 24.39, lon: 56.63, population: 0.2, tier: 'regional' },
  // ── PA ──
  { code: 'DAV', name: 'Enrique Malek', city: 'David', country: 'PA', lat: 8.39, lon: -82.43, population: 0.15, tier: 'regional' },
  // ── PE ──
  { code: 'TCQ', name: 'Coronel Carlos Ciriani', city: 'Tacna', country: 'PE', lat: -18.05, lon: -70.27, population: 0.3, tier: 'regional' },
  { code: 'CJA', name: 'Mayor Armando Revoredo', city: 'Cajamarca', country: 'PE', lat: -7.14, lon: -78.49, population: 0.28, tier: 'regional' },
  { code: 'PEM', name: 'Padre Aldamiz', city: 'Puerto Maldonado', country: 'PE', lat: -12.62, lon: -69.23, population: 0.08, visitors: 0.6, tier: 'regional' },
  // ── PF ──
  { code: 'BOB', name: 'Bora Bora', city: 'Bora Bora', country: 'PF', lat: -16.44, lon: -151.75, population: 0.01, visitors: 0.6, tier: 'regional' },
  // ── PG ──
  { code: 'LAE', name: 'Nadzab', city: 'Lae', country: 'PG', lat: -6.57, lon: 146.73, population: 0.2, tier: 'regional' },
  { code: 'RAB', name: 'Tokua', city: 'Rabaul', country: 'PG', lat: -4.34, lon: 152.38, population: 0.1, tier: 'regional' },
  { code: 'MAG', name: 'Madang', city: 'Madang', country: 'PG', lat: -5.21, lon: 145.79, population: 0.05, tier: 'regional' },
  // ── PH ──
  { code: 'BCD', name: 'Bacolod-Silay', city: 'Bacolod', country: 'PH', lat: 10.78, lon: 123.01, population: 0.6, tier: 'regional' },
  { code: 'BAG', name: 'Loakan', city: 'Baguio', country: 'PH', lat: 16.38, lon: 120.62, population: 0.35, visitors: 0.6, tier: 'regional' },
  { code: 'DGT', name: 'Sibulan', city: 'Dumaguete', country: 'PH', lat: 9.33, lon: 123.3, population: 0.13, tier: 'regional' },
  { code: 'ENI', name: 'El Nido', city: 'El Nido', country: 'PH', lat: 11.2, lon: 119.42, population: 0.04, visitors: 0.6, tier: 'regional' },
  { code: 'MPH', name: 'Godofredo P. Ramos', city: 'Caticlan', country: 'PH', lat: 11.92, lon: 121.95, population: 0.03, visitors: 0.6, tier: 'regional' },
  { code: 'IAO', name: 'Sayak', city: 'Siargao', country: 'PH', lat: 9.86, lon: 126.01, population: 0.02, visitors: 0.6, tier: 'regional' },
  // ── RU ──
  { code: 'KVX', name: 'Pobedilovo', city: 'Kirov', country: 'RU', lat: 58.5, lon: 49.35, population: 0.5, tier: 'regional' },
  { code: 'CSY', name: 'Cheboksary', city: 'Cheboksary', country: 'RU', lat: 56.09, lon: 47.35, population: 0.49, tier: 'regional' },
  { code: 'STW', name: 'Shpakovskoye', city: 'Stavropol', country: 'RU', lat: 45.11, lon: 42.11, population: 0.45, tier: 'regional' },
  { code: 'OGZ', name: 'Beslan', city: 'Vladikavkaz', country: 'RU', lat: 43.21, lon: 44.61, population: 0.3, tier: 'regional' },
  { code: 'GRV', name: 'Severny', city: 'Grozny', country: 'RU', lat: 43.39, lon: 45.7, population: 0.3, tier: 'regional' },
  { code: 'NAL', name: 'Nalchik', city: 'Nalchik', country: 'RU', lat: 43.51, lon: 43.64, population: 0.24, tier: 'regional' },
  { code: 'SCW', name: 'Syktyvkar', city: 'Syktyvkar', country: 'RU', lat: 61.65, lon: 50.84, population: 0.23, tier: 'regional' },
  { code: 'HMA', name: 'Khanty-Mansiysk', city: 'Khanty-Mansiysk', country: 'RU', lat: 61.03, lon: 69.09, population: 0.1, tier: 'regional' },
  // ── SD ──
  { code: 'PZU', name: 'Port Sudan New Intl', city: 'Port Sudan', country: 'SD', lat: 19.43, lon: 37.23, population: 0.5, tier: 'regional' },
  // ── SO ──
  { code: 'MGQ', name: 'Aden Adde Intl', city: 'Mogadishu', country: 'SO', lat: 2.01, lon: 45.3, population: 2.6, tier: 'regional' },
  // ── SY ──
  { code: 'ALP', name: 'Aleppo Intl', city: 'Aleppo', country: 'SY', lat: 36.18, lon: 37.22, population: 2, tier: 'regional' },
  // ── TH ──
  { code: 'UTH', name: 'Udon Thani Intl', city: 'Udon Thani', country: 'TH', lat: 17.38, lon: 102.79, population: 0.4, tier: 'regional' },
  { code: 'KBV', name: 'Krabi Intl', city: 'Krabi', country: 'TH', lat: 8.1, lon: 98.99, population: 0.1, visitors: 0.6, tier: 'regional' },
  // ── TN ──
  { code: 'MIR', name: 'Monastir Habib Bourguiba', city: 'Monastir', country: 'TN', lat: 35.76, lon: 10.75, population: 0.9, visitors: 0.3, tier: 'regional' },
  // ── TR ──
  { code: 'HTY', name: 'Hatay', city: 'Hatay', country: 'TR', lat: 36.36, lon: 36.28, population: 1.6, tier: 'regional' },
  { code: 'OGU', name: 'Ordu-Giresun', city: 'Ordu', country: 'TR', lat: 40.97, lon: 38.08, population: 0.7, tier: 'regional' },
  // ── TZ ──
  { code: 'ARK', name: 'Arusha', city: 'Arusha', country: 'TZ', lat: -3.37, lon: 36.63, population: 0.6, visitors: 0.3, tier: 'regional' },
  { code: 'MBI', name: 'Songwe', city: 'Mbeya', country: 'TZ', lat: -9.01, lon: 33.27, population: 0.5, tier: 'regional' },
  { code: 'DOD', name: 'Dodoma', city: 'Dodoma', country: 'TZ', lat: -6.17, lon: 35.75, population: 0.4, tier: 'regional' },
  // ── UZ ──
  { code: 'FEG', name: 'Fergana', city: 'Fergana', country: 'UZ', lat: 40.36, lon: 71.74, population: 0.3, tier: 'regional' },
  // ── VE ──
  { code: 'MAR', name: 'La Chinita Intl', city: 'Maracaibo', country: 'VE', lat: 10.56, lon: -71.73, population: 2.3, tier: 'regional' },
  { code: 'VLN', name: 'Arturo Michelena', city: 'Valencia', country: 'VE', lat: 10.15, lon: -67.93, population: 1.8, tier: 'regional' },
  { code: 'BRM', name: 'Jacinto Lara', city: 'Barquisimeto', country: 'VE', lat: 10.04, lon: -69.36, population: 1.1, tier: 'regional' },
  { code: 'BLA', name: 'Gen. Jose Antonio Anzoategui', city: 'Barcelona', country: 'VE', lat: 10.11, lon: -64.69, population: 0.9, tier: 'regional' },
  { code: 'PZO', name: 'Manuel Carlos Piar', city: 'Puerto Ordaz', country: 'VE', lat: 8.29, lon: -62.76, population: 0.9, tier: 'regional' },
  { code: 'PMV', name: 'Del Caribe', city: 'Porlamar', country: 'VE', lat: 10.91, lon: -63.97, population: 0.4, visitors: 0.6, tier: 'regional' },
  // ── VN ──
  { code: 'VDO', name: 'Van Don Intl', city: 'Ha Long', country: 'VN', lat: 21.12, lon: 107.41, population: 0.2, visitors: 0.6, tier: 'regional' },
  // ── ZA ──
  { code: 'PLZ', name: 'Chief Dawid Stuurman', city: 'Gqeberha', country: 'ZA', lat: -33.98, lon: 25.61, population: 1.2, tier: 'regional' },
  { code: 'ELS', name: 'East London', city: 'East London', country: 'ZA', lat: -33.04, lon: 27.83, population: 0.8, tier: 'regional' },
  { code: 'MQP', name: 'Kruger Mpumalanga', city: 'Mbombela', country: 'ZA', lat: -25.38, lon: 31.1, population: 0.7, visitors: 0.3, tier: 'regional' },
  { code: 'PTG', name: 'Polokwane Intl', city: 'Polokwane', country: 'ZA', lat: -23.85, lon: 29.46, population: 0.7, tier: 'regional' },
  { code: 'BFN', name: 'Bram Fischer Intl', city: 'Bloemfontein', country: 'ZA', lat: -29.09, lon: 26.3, population: 0.6, tier: 'regional' },
  { code: 'GRJ', name: 'George', city: 'George', country: 'ZA', lat: -34.01, lon: 22.38, population: 0.2, visitors: 0.6, tier: 'regional' },
  // ── ZM ──
  { code: 'NLA', name: 'Simon Mwansa Kapwepwe', city: 'Ndola', country: 'ZM', lat: -12.99, lon: 28.66, population: 0.5, tier: 'regional' },
  { code: 'LVI', name: 'Harry Mwanga Nkumbula', city: 'Livingstone', country: 'ZM', lat: -17.82, lon: 25.82, population: 0.2, visitors: 0.6, tier: 'regional' },
  { code: 'MFU', name: 'Mfuwe', city: 'Mfuwe', country: 'ZM', lat: -13.26, lon: 31.94, population: 0.02, visitors: 0.6, tier: 'regional' },
  // ── ZW ──
  { code: 'BUQ', name: 'Joshua Mqabuko Nkomo', city: 'Bulawayo', country: 'ZW', lat: -20.02, lon: 28.62, population: 0.7, tier: 'regional' },
  { code: 'VFA', name: 'Victoria Falls', city: 'Victoria Falls', country: 'ZW', lat: -18.1, lon: 25.84, population: 0.05, visitors: 0.6, tier: 'regional' },

  // ══════════════════════════════════════════════════════════════════════════
  // EXPANSION WAVE (2026-06-17) — 141 airports added via tools/airport-expansion
  // (tiered scorer: distinct + viable against the live gravity model)
  // ══════════════════════════════════════════════════════════════════════════
  // ── AM ──
  { code: 'LWN', name: 'Shirak', city: 'Gyumri', country: 'AM', lat: 40.75, lon: 43.86, population: 0.12, tier: 'regional' },
  // ── AO ──
  { code: 'CAB', name: 'Cabinda', city: 'Cabinda', country: 'AO', lat: -5.6, lon: 12.19, population: 0.6, tier: 'regional' },
  { code: 'MEG', name: 'Malanje', city: 'Malanje', country: 'AO', lat: -9.53, lon: 16.31, population: 0.5, tier: 'regional' },
  { code: 'SZA', name: 'Soyo', city: 'Soyo', country: 'AO', lat: -6.14, lon: 12.37, population: 0.2, tier: 'regional' },
  // ── AU ──
  { code: 'ABX', name: 'Albury', city: 'Albury', country: 'AU', lat: -36.07, lon: 146.96, population: 0.09, tier: 'regional' },
  { code: 'CFS', name: 'Coffs Harbour', city: 'Coffs Harbour', country: 'AU', lat: -30.32, lon: 153.12, population: 0.07, visitors: 0.6, tier: 'regional' },
  { code: 'TMW', name: 'Tamworth', city: 'Tamworth', country: 'AU', lat: -31.08, lon: 150.85, population: 0.06, tier: 'regional' },
  { code: 'GET', name: 'Geraldton', city: 'Geraldton', country: 'AU', lat: -28.8, lon: 114.71, population: 0.04, tier: 'regional' },
  { code: 'DBO', name: 'Dubbo City', city: 'Dubbo', country: 'AU', lat: -32.22, lon: 148.57, population: 0.04, tier: 'regional' },
  { code: 'KGI', name: 'Kalgoorlie-Boulder', city: 'Kalgoorlie', country: 'AU', lat: -30.79, lon: 121.46, population: 0.03, tier: 'regional' },
  // ── BQ ──
  { code: 'BON', name: 'Flamingo Intl', city: 'Bonaire', country: 'BQ', lat: 12.13, lon: -68.27, population: 0.02, visitors: 0.6, tier: 'regional' },
  // ── BR ──
  { code: 'SJK', name: 'Sao Jose dos Campos', city: 'Sao Jose dos Campos', country: 'BR', lat: -23.23, lon: -45.86, population: 0.7, tier: 'regional' },
  { code: 'JDF', name: 'Francisco de Assis', city: 'Juiz de Fora', country: 'BR', lat: -21.79, lon: -43.39, population: 0.57, tier: 'regional' },
  { code: 'BAU', name: 'Bauru-Arealva', city: 'Bauru', country: 'BR', lat: -22.16, lon: -49.07, population: 0.38, tier: 'regional' },
  { code: 'UBA', name: 'Mario de Almeida', city: 'Uberaba', country: 'BR', lat: -19.76, lon: -47.96, population: 0.34, tier: 'regional' },
  { code: 'PET', name: 'Joao Simoes Lopes Neto', city: 'Pelotas', country: 'BR', lat: -31.72, lon: -52.33, population: 0.34, tier: 'regional' },
  { code: 'GVR', name: 'Coronel Altino Machado', city: 'Governador Valadares', country: 'BR', lat: -18.9, lon: -41.98, population: 0.28, tier: 'regional' },
  { code: 'RIA', name: 'Santa Maria', city: 'Santa Maria', country: 'BR', lat: -29.71, lon: -53.69, population: 0.27, tier: 'regional' },
  { code: 'MII', name: 'Frank Miloye', city: 'Marilia', country: 'BR', lat: -22.2, lon: -49.93, population: 0.24, tier: 'regional' },
  { code: 'PPB', name: 'Adhemar de Barros', city: 'Presidente Prudente', country: 'BR', lat: -22.18, lon: -51.42, population: 0.23, tier: 'regional' },
  { code: 'ROO', name: 'Maestro Marinho Franco', city: 'Rondonopolis', country: 'BR', lat: -16.59, lon: -54.72, population: 0.23, tier: 'regional' },
  { code: 'DOU', name: 'Francisco de Matos Pereira', city: 'Dourados', country: 'BR', lat: -22.2, lon: -54.93, population: 0.22, tier: 'regional' },
  { code: 'ARU', name: 'Dario Guarita', city: 'Aracatuba', country: 'BR', lat: -21.14, lon: -50.42, population: 0.2, tier: 'regional' },
  { code: 'PFB', name: 'Lauro Kurtz', city: 'Passo Fundo', country: 'BR', lat: -28.24, lon: -52.33, population: 0.2, tier: 'regional' },
  { code: 'URG', name: 'Rubem Berta', city: 'Uruguaiana', country: 'BR', lat: -29.78, lon: -57.04, population: 0.13, tier: 'regional' },
  { code: 'PIN', name: 'Julio Belem', city: 'Parintins', country: 'BR', lat: -2.63, lon: -56.78, population: 0.11, tier: 'regional' },
  { code: 'BVH', name: 'Brigadeiro Camarao', city: 'Vilhena', country: 'BR', lat: -12.69, lon: -60.1, population: 0.1, tier: 'regional' },
  { code: 'TFF', name: 'Tefe', city: 'Tefe', country: 'BR', lat: -3.38, lon: -64.72, population: 0.06, tier: 'regional' },
  { code: 'AFL', name: 'Piloto Osvaldo Marques', city: 'Alta Floresta', country: 'BR', lat: -9.87, lon: -56.1, population: 0.05, tier: 'regional' },
  { code: 'BYO', name: 'Bonito', city: 'Bonito', country: 'BR', lat: -21.25, lon: -56.45, population: 0.02, visitors: 0.6, tier: 'regional' },
  // ── CA ──
  { code: 'YYT', name: 'St John\'s Intl', city: 'St John\'s', country: 'CA', lat: 47.62, lon: -52.75, population: 0.21, tier: 'regional' },
  { code: 'YSB', name: 'Sudbury', city: 'Sudbury', country: 'CA', lat: 46.63, lon: -80.8, population: 0.16, tier: 'regional' },
  { code: 'YQM', name: 'Greater Moncton', city: 'Moncton', country: 'CA', lat: 46.11, lon: -64.68, population: 0.15, tier: 'regional' },
  // ── CD ──
  { code: 'MDK', name: 'Mbandaka', city: 'Mbandaka', country: 'CD', lat: 0.02, lon: 18.29, population: 0.4, tier: 'regional' },
  // ── CI ──
  { code: 'SPY', name: 'San Pedro', city: 'San Pedro', country: 'CI', lat: 4.75, lon: -6.66, population: 0.2, tier: 'regional' },
  // ── CK ──
  { code: 'AIT', name: 'Aitutaki', city: 'Aitutaki', country: 'CK', lat: -18.83, lon: -159.76, population: 0.002, visitors: 0.6, tier: 'regional' },
  // ── CN ──
  { code: 'SQD', name: 'Sanqingshan', city: 'Shangrao', country: 'CN', lat: 28.39, lon: 117.96, population: 6.5, tier: 'major' },
  { code: 'YIC', name: 'Mingyueshan', city: 'Yichun', country: 'CN', lat: 27.8, lon: 114.31, population: 5.1, tier: 'regional' },
  { code: 'HCJ', name: 'Jinchengjiang', city: 'Hechi', country: 'CN', lat: 24.99, lon: 107.7, population: 3.4, tier: 'regional' },
  { code: 'SQJ', name: 'Shaxian', city: 'Sanming', country: 'CN', lat: 26.43, lon: 117.83, population: 2.5, tier: 'regional' },
  { code: 'DBC', name: 'Changan', city: 'Baicheng', country: 'CN', lat: 45.5, lon: 123.02, population: 1.5, tier: 'regional' },
  { code: 'GYU', name: 'Liupanshan', city: 'Guyuan', country: 'CN', lat: 36.07, lon: 106.22, population: 1.2, tier: 'regional' },
  { code: 'GXH', name: 'Xiahe', city: 'Gannan', country: 'CN', lat: 34.81, lon: 102.64, population: 0.7, visitors: 0.3, tier: 'regional' },
  { code: 'TLQ', name: 'Jiaohe', city: 'Turpan', country: 'CN', lat: 43.03, lon: 89.1, population: 0.6, visitors: 0.3, tier: 'regional' },
  { code: 'WUA', name: 'Wuhai', city: 'Wuhai', country: 'CN', lat: 39.79, lon: 106.8, population: 0.5, tier: 'regional' },
  { code: 'OHE', name: 'Gulian', city: 'Mohe', country: 'CN', lat: 52.91, lon: 122.43, population: 0.08, visitors: 0.6, tier: 'regional' },
  // ── CU ──
  { code: 'CMW', name: 'Ignacio Agramonte', city: 'Camaguey', country: 'CU', lat: 21.42, lon: -77.85, population: 0.32, tier: 'regional' },
  { code: 'SNU', name: 'Abel Santamaria', city: 'Santa Clara', country: 'CU', lat: 22.49, lon: -79.94, population: 0.24, tier: 'regional' },
  // ── DO ──
  { code: 'LRM', name: 'Casa de Campo', city: 'La Romana', country: 'DO', lat: 18.45, lon: -68.91, population: 0.05, visitors: 0.6, tier: 'regional' },
  // ── DZ ──
  { code: 'BLJ', name: 'Mostefa Ben Boulaid', city: 'Batna', country: 'DZ', lat: 35.75, lon: 6.31, population: 0.3, tier: 'regional' },
  { code: 'BSK', name: 'Mohamed Khider', city: 'Biskra', country: 'DZ', lat: 34.79, lon: 5.74, population: 0.3, tier: 'regional' },
  { code: 'TLM', name: 'Zenata', city: 'Tlemcen', country: 'DZ', lat: 35.02, lon: -1.45, population: 0.2, tier: 'regional' },
  // ── EG ──
  { code: 'ATZ', name: 'Asyut', city: 'Asyut', country: 'EG', lat: 27.05, lon: 31.01, population: 0.5, tier: 'regional' },
  // ── ET ──
  { code: 'JIJ', name: 'Jijiga Wilwal', city: 'Jijiga', country: 'ET', lat: 9.36, lon: 42.91, population: 0.2, tier: 'regional' },
  // ── FJ ──
  { code: 'TVU', name: 'Matei', city: 'Taveuni', country: 'FJ', lat: -16.69, lon: 179.88, population: 0.01, visitors: 0.6, tier: 'regional' },
  // ── GA ──
  { code: 'FOU', name: 'Mvengue', city: 'Franceville', country: 'GA', lat: -1.65, lon: 13.44, population: 0.1, tier: 'regional' },
  // ── GH ──
  { code: 'TKD', name: 'Takoradi', city: 'Takoradi', country: 'GH', lat: 4.9, lon: -1.77, population: 0.4, tier: 'regional' },
  // ── GP ──
  { code: 'PTP', name: 'Pointe-a-Pitre', city: 'Pointe-a-Pitre', country: 'GP', lat: 16.27, lon: -61.53, population: 0.38, visitors: 0.6, tier: 'regional' },
  // ── GQ ──
  { code: 'BSG', name: 'Bata', city: 'Bata', country: 'GQ', lat: 1.91, lon: 9.81, population: 0.3, tier: 'regional' },
  // ── HN ──
  { code: 'LCE', name: 'Goloson Intl', city: 'La Ceiba', country: 'HN', lat: 15.74, lon: -86.85, population: 0.2, tier: 'regional' },
  { code: 'XPL', name: 'Palmerola Intl', city: 'Comayagua', country: 'HN', lat: 14.38, lon: -87.62, population: 0.15, tier: 'regional' },
  // ── HT ──
  { code: 'CAP', name: 'Hugo Chavez Intl', city: 'Cap-Haitien', country: 'HT', lat: 19.73, lon: -72.19, population: 0.27, tier: 'regional' },
  // ── ID ──
  { code: 'DUM', name: 'Pinang Kampai', city: 'Dumai', country: 'ID', lat: 1.61, lon: 101.43, population: 0.3, tier: 'regional' },
  { code: 'PKY', name: 'Tjilik Riwut', city: 'Palangkaraya', country: 'ID', lat: -2.23, lon: 113.94, population: 0.27, tier: 'regional' },
  { code: 'TNJ', name: 'Raja Haji Fisabilillah', city: 'Tanjung Pinang', country: 'ID', lat: 0.92, lon: 104.53, population: 0.2, tier: 'regional' },
  { code: 'NTX', name: 'Ranai', city: 'Natuna', country: 'ID', lat: 3.91, lon: 108.39, population: 0.08, tier: 'regional' },
  { code: 'SQG', name: 'Tebelian', city: 'Sintang', country: 'ID', lat: 0.06, lon: 111.47, population: 0.06, tier: 'regional' },
  { code: 'SWQ', name: 'Sultan Kaharuddin', city: 'Sumbawa Besar', country: 'ID', lat: -8.49, lon: 117.41, population: 0.06, tier: 'regional' },
  { code: 'OTI', name: 'Pitu', city: 'Morotai', country: 'ID', lat: 2.05, lon: 128.32, population: 0.05, visitors: 0.6, tier: 'regional' },
  { code: 'LUV', name: 'Karel Sadsuitubun', city: 'Langgur', country: 'ID', lat: -5.66, lon: 132.73, population: 0.05, visitors: 0.6, tier: 'regional' },
  // ── IN ──
  { code: 'AIP', name: 'Adampur', city: 'Jalandhar', country: 'IN', lat: 31.43, lon: 75.76, population: 0.9, tier: 'regional' },
  { code: 'PAB', name: 'Bilaspur', city: 'Bilaspur', country: 'IN', lat: 22.1, lon: 82.11, population: 0.4, tier: 'regional' },
  { code: 'SLV', name: 'Shimla', city: 'Shimla', country: 'IN', lat: 31.08, lon: 77.07, population: 0.2, visitors: 0.6, tier: 'regional' },
  // ── IR ──
  { code: 'ADU', name: 'Ardabil', city: 'Ardabil', country: 'IR', lat: 38.33, lon: 48.42, population: 0.5, tier: 'regional' },
  { code: 'ABD', name: 'Abadan', city: 'Abadan', country: 'IR', lat: 30.37, lon: 48.23, population: 0.3, tier: 'regional' },
  { code: 'XBJ', name: 'Birjand', city: 'Birjand', country: 'IR', lat: 32.9, lon: 59.27, population: 0.2, tier: 'regional' },
  { code: 'GSM', name: 'Qeshm Intl', city: 'Qeshm', country: 'IR', lat: 26.75, lon: 55.9, population: 0.1, visitors: 0.6, tier: 'regional' },
  // ── KE ──
  { code: 'LAU', name: 'Manda', city: 'Lamu', country: 'KE', lat: -2.25, lon: 40.91, population: 0.03, visitors: 0.6, tier: 'regional' },
  // ── KI ──
  { code: 'CXI', name: 'Cassidy Intl', city: 'Kiritimati', country: 'KI', lat: 1.99, lon: -157.35, population: 0.006, visitors: 0.6, tier: 'regional' },
  // ── LA ──
  { code: 'ZVK', name: 'Savannakhet', city: 'Savannakhet', country: 'LA', lat: 16.56, lon: 104.76, population: 0.12, tier: 'regional' },
  // ── LY ──
  { code: 'SEB', name: 'Sabha', city: 'Sabha', country: 'LY', lat: 27.01, lon: 14.47, population: 0.13, tier: 'regional' },
  // ── MA ──
  { code: 'TTU', name: 'Sania Ramel', city: 'Tetouan', country: 'MA', lat: 35.59, lon: -5.32, population: 0.4, tier: 'regional' },
  { code: 'NDR', name: 'Nador Al Aroui', city: 'Nador', country: 'MA', lat: 34.99, lon: -3.03, population: 0.2, tier: 'regional' },
  { code: 'OZZ', name: 'Ouarzazate', city: 'Ouarzazate', country: 'MA', lat: 30.94, lon: -6.91, population: 0.07, visitors: 0.6, tier: 'regional' },
  // ── MG ──
  { code: 'TLE', name: 'Toliara', city: 'Toliara', country: 'MG', lat: -23.38, lon: 43.73, population: 0.2, tier: 'regional' },
  { code: 'SMS', name: 'Sainte Marie', city: 'Sainte Marie', country: 'MG', lat: -17.09, lon: 49.82, population: 0.02, visitors: 0.6, tier: 'regional' },
  // ── MM ──
  { code: 'MGZ', name: 'Myeik', city: 'Myeik', country: 'MM', lat: 12.44, lon: 98.62, population: 0.28, tier: 'regional' },
  { code: 'SNW', name: 'Thandwe', city: 'Ngapali', country: 'MM', lat: 18.46, lon: 94.3, population: 0.05, visitors: 0.6, tier: 'regional' },
  // ── MN ──
  { code: 'HVD', name: 'Khovd', city: 'Khovd', country: 'MN', lat: 47.95, lon: 91.62, population: 0.1, tier: 'regional' },
  { code: 'DLZ', name: 'Gurvan Saikhan', city: 'Dalanzadgad', country: 'MN', lat: 43.59, lon: 104.42, population: 0.04, visitors: 0.6, tier: 'regional' },
  // ── MQ ──
  { code: 'FDF', name: 'Martinique Aime Cesaire', city: 'Fort-de-France', country: 'MQ', lat: 14.59, lon: -61, population: 0.35, visitors: 0.6, tier: 'regional' },
  // ── MX ──
  { code: 'PAZ', name: 'El Tajin', city: 'Poza Rica', country: 'MX', lat: 20.6, lon: -97.46, population: 0.2, tier: 'regional' },
  { code: 'MTT', name: 'Minatitlan', city: 'Minatitlan', country: 'MX', lat: 17.99, lon: -94.58, population: 0.2, tier: 'regional' },
  { code: 'LZC', name: 'Lazaro Cardenas', city: 'Lazaro Cardenas', country: 'MX', lat: 18, lon: -102.22, population: 0.18, tier: 'regional' },
  // ── MY ──
  { code: 'MZV', name: 'Mulu', city: 'Mulu', country: 'MY', lat: 4.05, lon: 114.81, population: 0.01, visitors: 0.6, tier: 'regional' },
  // ── MZ ──
  { code: 'VPY', name: 'Chingozi', city: 'Tete', country: 'MZ', lat: -16.1, lon: 33.64, population: 0.3, tier: 'regional' },
  { code: 'MNC', name: 'Nacala', city: 'Nacala', country: 'MZ', lat: -14.49, lon: 40.71, population: 0.2, tier: 'regional' },
  // ── NC ──
  { code: 'LIF', name: 'Lifou', city: 'Lifou', country: 'NC', lat: -20.77, lon: 167.24, population: 0.01, visitors: 0.6, tier: 'regional' },
  // ── NG ──
  { code: 'YOL', name: 'Yola', city: 'Yola', country: 'NG', lat: 9.26, lon: 12.43, population: 0.6, tier: 'regional' },
  { code: 'ABB', name: 'Asaba Intl', city: 'Asaba', country: 'NG', lat: 6.2, lon: 6.66, population: 0.5, tier: 'regional' },
  { code: 'GMO', name: 'Gombe Lawanti', city: 'Gombe', country: 'NG', lat: 10.3, lon: 11.42, population: 0.5, tier: 'regional' },
  { code: 'MXJ', name: 'Minna', city: 'Minna', country: 'NG', lat: 9.65, lon: 6.46, population: 0.4, tier: 'regional' },
  // ── NZ ──
  { code: 'PMR', name: 'Palmerston North', city: 'Palmerston North', country: 'NZ', lat: -40.32, lon: 175.62, population: 0.09, tier: 'regional' },
  { code: 'ROT', name: 'Rotorua', city: 'Rotorua', country: 'NZ', lat: -38.11, lon: 176.32, population: 0.07, visitors: 0.6, tier: 'regional' },
  { code: 'NSN', name: 'Nelson', city: 'Nelson', country: 'NZ', lat: -41.3, lon: 173.22, population: 0.07, tier: 'regional' },
  { code: 'IVC', name: 'Invercargill', city: 'Invercargill', country: 'NZ', lat: -46.41, lon: 168.31, population: 0.06, tier: 'regional' },
  { code: 'NPL', name: 'New Plymouth', city: 'New Plymouth', country: 'NZ', lat: -39.01, lon: 174.18, population: 0.06, tier: 'regional' },
  // ── PA ──
  { code: 'CTD', name: 'Enrique Malek', city: 'Chitre', country: 'PA', lat: 7.99, lon: -80.41, population: 0.1, tier: 'regional' },
  // ── PF ──
  { code: 'HUH', name: 'Huahine', city: 'Huahine', country: 'PF', lat: -16.69, lon: -151.02, population: 0.006, visitors: 0.6, tier: 'regional' },
  { code: 'RGI', name: 'Rangiroa', city: 'Rangiroa', country: 'PF', lat: -14.95, lon: -147.66, population: 0.003, visitors: 0.6, tier: 'regional' },
  // ── PG ──
  { code: 'WWK', name: 'Wewak', city: 'Wewak', country: 'PG', lat: -3.58, lon: 143.67, population: 0.05, tier: 'regional' },
  { code: 'GKA', name: 'Goroka', city: 'Goroka', country: 'PG', lat: -6.08, lon: 145.39, population: 0.05, tier: 'regional' },
  // ── PH ──
  { code: 'CYZ', name: 'Cauayan', city: 'Cauayan', country: 'PH', lat: 16.93, lon: 121.75, population: 0.13, tier: 'regional' },
  { code: 'BSO', name: 'Basco', city: 'Batanes', country: 'PH', lat: 20.45, lon: 121.98, population: 0.02, visitors: 0.6, tier: 'regional' },
  { code: 'CGM', name: 'Camiguin', city: 'Camiguin', country: 'PH', lat: 9.25, lon: 124.71, population: 0.02, visitors: 0.6, tier: 'regional' },
  // ── PR ──
  { code: 'BQN', name: 'Rafael Hernandez', city: 'Aguadilla', country: 'PR', lat: 18.49, lon: -67.13, population: 0.2, tier: 'regional' },
  { code: 'PSE', name: 'Mercedita', city: 'Ponce', country: 'PR', lat: 18.01, lon: -66.56, population: 0.13, tier: 'regional' },
  // ── SB ──
  { code: 'GZO', name: 'Nusatupe', city: 'Gizo', country: 'SB', lat: -8.1, lon: 156.86, population: 0.01, visitors: 0.6, tier: 'regional' },
  // ── SN ──
  { code: 'CSK', name: 'Cap Skirring', city: 'Cap Skirring', country: 'SN', lat: 12.4, lon: -16.75, population: 0.02, visitors: 0.6, tier: 'regional' },
  // ── SO ──
  { code: 'GLK', name: 'Galkayo', city: 'Galkayo', country: 'SO', lat: 6.78, lon: 47.45, population: 0.15, tier: 'regional' },
  { code: 'BBO', name: 'Berbera', city: 'Berbera', country: 'SO', lat: 10.39, lon: 44.94, population: 0.05, tier: 'regional' },
  // ── SY ──
  { code: 'LTK', name: 'Bassel Al-Assad', city: 'Latakia', country: 'SY', lat: 35.4, lon: 35.95, population: 0.4, visitors: 0.6, tier: 'regional' },
  // ── TC ──
  { code: 'PLS', name: 'Providenciales', city: 'Providenciales', country: 'TC', lat: 21.77, lon: -72.27, population: 0.05, visitors: 0.6, tier: 'regional' },
  // ── TH ──
  { code: 'HHQ', name: 'Hua Hin', city: 'Hua Hin', country: 'TH', lat: 12.62, lon: 99.95, population: 0.05, visitors: 0.6, tier: 'regional' },
  // ── TM ──
  { code: 'CRZ', name: 'Turkmenabat', city: 'Turkmenabat', country: 'TM', lat: 39.08, lon: 63.61, population: 0.25, tier: 'regional' },
  { code: 'MYP', name: 'Mary', city: 'Mary', country: 'TM', lat: 37.62, lon: 61.9, population: 0.12, tier: 'regional' },
  // ── TN ──
  { code: 'TOE', name: 'Tozeur-Nefta', city: 'Tozeur', country: 'TN', lat: 33.94, lon: 8.11, population: 0.05, visitors: 0.6, tier: 'regional' },
  // ── TR ──
  { code: 'KCM', name: 'Kahramanmaras', city: 'Kahramanmaras', country: 'TR', lat: 37.54, lon: 36.95, population: 0.6, tier: 'regional' },
  { code: 'VAS', name: 'Sivas Nuri Demirag', city: 'Sivas', country: 'TR', lat: 39.81, lon: 36.9, population: 0.6, tier: 'regional' },
  // ── TT ──
  { code: 'TAB', name: 'A.N.R. Robinson', city: 'Tobago', country: 'TT', lat: 11.15, lon: -60.83, population: 0.06, visitors: 0.6, tier: 'regional' },
  // ── UZ ──
  { code: 'KSQ', name: 'Karshi', city: 'Karshi', country: 'UZ', lat: 38.83, lon: 65.92, population: 0.28, tier: 'regional' },
  // ── VG ──
  { code: 'EIS', name: 'Terrance B. Lettsome', city: 'Tortola', country: 'VG', lat: 18.44, lon: -64.54, population: 0.03, visitors: 0.6, tier: 'regional' },
  // ── VN ──
  { code: 'VCS', name: 'Con Dao', city: 'Con Dao', country: 'VN', lat: 8.73, lon: 106.63, population: 0.005, visitors: 0.6, tier: 'regional' },
  // ── VU ──
  { code: 'SON', name: 'Santo Pekoa', city: 'Espiritu Santo', country: 'VU', lat: -15.51, lon: 167.22, population: 0.04, tier: 'regional' },
  // ── YE ──
  { code: 'TAI', name: 'Taiz Intl', city: 'Taiz', country: 'YE', lat: 13.69, lon: 44.14, population: 0.6, tier: 'regional' },
  { code: 'HOD', name: 'Hodeidah Intl', city: 'Hodeidah', country: 'YE', lat: 14.75, lon: 42.98, population: 0.5, tier: 'regional' },
  { code: 'RIY', name: 'Riyan', city: 'Mukalla', country: 'YE', lat: 14.66, lon: 49.38, population: 0.3, tier: 'regional' },
  { code: 'SCT', name: 'Socotra', city: 'Socotra', country: 'YE', lat: 12.63, lon: 54.01, population: 0.04, visitors: 0.6, tier: 'regional' },
  // ── ZA ──
  { code: 'PZB', name: 'Pietermaritzburg', city: 'Pietermaritzburg', country: 'ZA', lat: -29.65, lon: 30.4, population: 0.7, tier: 'regional' },
  { code: 'KIM', name: 'Kimberley', city: 'Kimberley', country: 'ZA', lat: -28.8, lon: 24.77, population: 0.25, tier: 'regional' },
  { code: 'UTN', name: 'Upington', city: 'Upington', country: 'ZA', lat: -28.4, lon: 21.26, population: 0.1, tier: 'regional' },

  // ══════════════════════════════════════════════════════════════════════════
  // EXPANSION WAVE (2026-06-17) — 44 airports added via tools/airport-expansion
  // (tiered scorer: distinct + viable against the live gravity model)
  // ══════════════════════════════════════════════════════════════════════════
  // ── AO ──
  { code: 'SVP', name: 'Kuito', city: 'Kuito', country: 'AO', lat: -12.4, lon: 16.95, population: 0.4, tier: 'regional' },
  { code: 'VHC', name: 'Saurimo', city: 'Saurimo', country: 'AO', lat: -9.69, lon: 20.43, population: 0.2, tier: 'regional' },
  // ── CD ──
  { code: 'BKY', name: 'Kavumu', city: 'Bukavu', country: 'CD', lat: -2.31, lon: 28.81, population: 1.1, tier: 'regional' },
  { code: 'KND', name: 'Kindu', city: 'Kindu', country: 'CD', lat: -2.92, lon: 25.92, population: 0.3, tier: 'regional' },
  // ── CM ──
  { code: 'BFX', name: 'Bafoussam', city: 'Bafoussam', country: 'CM', lat: 5.54, lon: 10.35, population: 0.4, tier: 'regional' },
  // ── CN ──
  { code: 'ZQZ', name: 'Ningyuan', city: 'Zhangjiakou', country: 'CN', lat: 40.74, lon: 114.93, population: 4.4, tier: 'regional' },
  { code: 'GYS', name: 'Panlong', city: 'Guangyuan', country: 'CN', lat: 32.39, lon: 105.7, population: 2.3, tier: 'regional' },
  { code: 'UCB', name: 'Jining', city: 'Ulanqab', country: 'CN', lat: 41.13, lon: 113.1, population: 2.1, tier: 'regional' },
  { code: 'RLK', name: 'Tianjitai', city: 'Bayannur', country: 'CN', lat: 40.93, lon: 107.74, population: 1.7, tier: 'regional' },
  { code: 'HLH', name: 'Yilelite', city: 'Ulanhot', country: 'CN', lat: 46.2, lon: 122.01, population: 1.4, tier: 'regional' },
  { code: 'TCZ', name: 'Tuofeng', city: 'Tengchong', country: 'CN', lat: 24.94, lon: 98.49, population: 0.7, visitors: 0.3, tier: 'regional' },
  { code: 'YUS', name: 'Batang', city: 'Yushu', country: 'CN', lat: 32.84, lon: 97.04, population: 0.4, visitors: 0.6, tier: 'regional' },
  { code: 'XIL', name: 'Xilinhot', city: 'Xilinhot', country: 'CN', lat: 43.92, lon: 115.96, population: 0.3, tier: 'regional' },
  { code: 'NZH', name: 'Xijiao', city: 'Manzhouli', country: 'CN', lat: 49.57, lon: 117.33, population: 0.3, tier: 'regional' },
  // ── GR ──
  { code: 'KLX', name: 'Kalamata', city: 'Kalamata', country: 'GR', lat: 37.07, lon: 22.03, population: 0.07, visitors: 0.6, tier: 'regional' },
  { code: 'SMI', name: 'Samos', city: 'Samos', country: 'GR', lat: 37.69, lon: 26.91, population: 0.04, visitors: 0.6, tier: 'regional' },
  // ── ID ──
  { code: 'KTG', name: 'Rahadi Oesman', city: 'Ketapang', country: 'ID', lat: -1.82, lon: 109.96, population: 0.13, tier: 'regional' },
  { code: 'SUP', name: 'Trunojoyo', city: 'Sumenep', country: 'ID', lat: -7.02, lon: 113.89, population: 0.1, tier: 'regional' },
  { code: 'TJS', name: 'Tanjung Selor', city: 'Tanjung Selor', country: 'ID', lat: 2.84, lon: 117.37, population: 0.1, tier: 'regional' },
  { code: 'ARD', name: 'Mali', city: 'Alor', country: 'ID', lat: -8.13, lon: 124.6, population: 0.06, tier: 'regional' },
  // ── LY ──
  { code: 'LAQ', name: 'Beida Intl', city: 'Beida', country: 'LY', lat: 32.79, lon: 21.96, population: 0.25, tier: 'regional' },
  // ── MG ──
  { code: 'MOQ', name: 'Morondava', city: 'Morondava', country: 'MG', lat: -20.28, lon: 44.32, population: 0.06, visitors: 0.6, tier: 'regional' },
  // ── ML ──
  { code: 'MZI', name: 'Mopti Ambodedjo', city: 'Mopti', country: 'ML', lat: 14.51, lon: -4.08, population: 0.12, tier: 'regional' },
  { code: 'GAQ', name: 'Gao', city: 'Gao', country: 'ML', lat: 16.25, lon: -0.01, population: 0.1, tier: 'regional' },
  // ── NE ──
  { code: 'ZND', name: 'Zinder', city: 'Zinder', country: 'NE', lat: 13.78, lon: 8.98, population: 0.3, tier: 'regional' },
  // ── NG ──
  { code: 'IBA', name: 'Ibadan', city: 'Ibadan', country: 'NG', lat: 7.36, lon: 3.97, population: 3.6, tier: 'regional' },
  { code: 'BCU', name: 'Bauchi Sani Abacha', city: 'Bauchi', country: 'NG', lat: 10.48, lon: 9.74, population: 0.5, tier: 'regional' },
  { code: 'DKA', name: 'Katsina', city: 'Katsina', country: 'NG', lat: 12.93, lon: 7.65, population: 0.4, tier: 'regional' },
  { code: 'MDI', name: 'Makurdi', city: 'Makurdi', country: 'NG', lat: 7.7, lon: 8.61, population: 0.3, tier: 'regional' },
  // ── RU ──
  { code: 'BTK', name: 'Bratsk', city: 'Bratsk', country: 'RU', lat: 56.37, lon: 101.7, population: 0.23, tier: 'regional' },
  { code: 'NSK', name: 'Alykel', city: 'Norilsk', country: 'RU', lat: 69.31, lon: 87.33, population: 0.18, tier: 'regional' },
  { code: 'KYZ', name: 'Kyzyl', city: 'Kyzyl', country: 'RU', lat: 51.67, lon: 94.4, population: 0.12, tier: 'regional' },
  { code: 'NOJ', name: 'Noyabrsk', city: 'Noyabrsk', country: 'RU', lat: 63.18, lon: 75.27, population: 0.1, tier: 'regional' },
  { code: 'NER', name: 'Chulman Neryungri', city: 'Neryungri', country: 'RU', lat: 56.91, lon: 124.91, population: 0.06, tier: 'regional' },
  { code: 'RGK', name: 'Gorno-Altaysk', city: 'Gorno-Altaysk', country: 'RU', lat: 51.97, lon: 85.83, population: 0.06, visitors: 0.6, tier: 'regional' },
  { code: 'VKT', name: 'Vorkuta', city: 'Vorkuta', country: 'RU', lat: 67.49, lon: 63.99, population: 0.06, tier: 'regional' },
  // ── SD ──
  { code: 'NHF', name: 'Nyala', city: 'Nyala', country: 'SD', lat: 12.05, lon: 24.96, population: 0.5, tier: 'regional' },
  { code: 'EBD', name: 'El Obeid', city: 'El Obeid', country: 'SD', lat: 13.15, lon: 30.23, population: 0.4, tier: 'regional' },
  // ── SO ──
  { code: 'KMU', name: 'Kismayo', city: 'Kismayo', country: 'SO', lat: -0.38, lon: 42.46, population: 0.2, tier: 'regional' },
  // ── TD ──
  { code: 'MQQ', name: 'Moundou', city: 'Moundou', country: 'TD', lat: 8.62, lon: 16.07, population: 0.14, tier: 'regional' },
  // ── TZ ──
  { code: 'MYW', name: 'Mtwara', city: 'Mtwara', country: 'TZ', lat: -10.34, lon: 40.18, population: 0.2, tier: 'regional' },
  // ── ZA ──
  { code: 'RCB', name: 'Richards Bay', city: 'Richards Bay', country: 'ZA', lat: -28.74, lon: 32.09, population: 0.2, tier: 'regional' },
  // ── ZM ──
  { code: 'KIW', name: 'Southdowns', city: 'Kitwe', country: 'ZM', lat: -12.9, lon: 28.15, population: 0.5, tier: 'regional' },
  // ── ZW ──
  { code: 'HWN', name: 'Hwange Nat. Park', city: 'Hwange', country: 'ZW', lat: -18.63, lon: 27.02, population: 0.02, visitors: 0.6, tier: 'regional' },

  // ══════════════════════════════════════════════════════════════════════════
  // EXPANSION WAVE (2026-06-17) — 42 airports added via tools/airport-expansion
  // (tiered scorer: distinct + viable against the live gravity model)
  // ══════════════════════════════════════════════════════════════════════════
  // ── US ──
  { code: 'MCI', name: 'Kansas City Intl', city: 'Kansas City', country: 'US', lat: 39.3, lon: -94.71, population: 2.2, tier: 'regional' },
  { code: 'BDL', name: 'Bradley Intl', city: 'Hartford', country: 'US', lat: 41.94, lon: -72.68, population: 1.2, tier: 'regional' },
  { code: 'STS', name: 'Charles M. Schulz Sonoma', city: 'Santa Rosa', country: 'US', lat: 38.51, lon: -122.81, population: 0.49, tier: 'regional' },
  { code: 'PSP', name: 'Palm Springs Intl', city: 'Palm Springs', country: 'US', lat: 33.83, lon: -116.51, population: 0.47, visitors: 0.6, tier: 'regional' },
  { code: 'FAY', name: 'Fayetteville Regional', city: 'Fayetteville', country: 'US', lat: 34.99, lon: -78.88, population: 0.4, tier: 'regional' },
  { code: 'BPT', name: 'Jack Brooks Regional', city: 'Beaumont', country: 'US', lat: 29.95, lon: -94.02, population: 0.4, tier: 'regional' },
  { code: 'MGM', name: 'Montgomery Regional', city: 'Montgomery', country: 'US', lat: 32.3, lon: -86.39, population: 0.4, tier: 'regional' },
  { code: 'PIA', name: 'General Wayne A. Downing Peoria', city: 'Peoria', country: 'US', lat: 40.66, lon: -89.69, population: 0.37, tier: 'regional' },
  { code: 'RFD', name: 'Chicago Rockford Intl', city: 'Rockford', country: 'US', lat: 42.2, lon: -89.1, population: 0.34, tier: 'regional' },
  { code: 'CSG', name: 'Columbus Metropolitan', city: 'Columbus', country: 'US', lat: 32.52, lon: -84.94, population: 0.3, tier: 'regional' },
  { code: 'LRD', name: 'Laredo Intl', city: 'Laredo', country: 'US', lat: 27.54, lon: -99.46, population: 0.26, tier: 'regional' },
  { code: 'CLL', name: 'Easterwood Field', city: 'College Station', country: 'US', lat: 30.59, lon: -96.36, population: 0.25, tier: 'regional' },
  { code: 'MFR', name: 'Rogue Valley Intl-Medford', city: 'Medford', country: 'US', lat: 42.37, lon: -122.87, population: 0.22, tier: 'regional' },
  { code: 'HYA', name: 'Cape Cod Gateway', city: 'Hyannis', country: 'US', lat: 41.67, lon: -70.28, population: 0.2, visitors: 0.6, tier: 'regional' },
  { code: 'FLO', name: 'Florence Regional', city: 'Florence', country: 'US', lat: 34.19, lon: -79.72, population: 0.2, tier: 'regional' },
  { code: 'LCH', name: 'Lake Charles Regional', city: 'Lake Charles', country: 'US', lat: 30.13, lon: -93.22, population: 0.2, tier: 'regional' },
  { code: 'BMI', name: 'Central Illinois Regional', city: 'Bloomington', country: 'US', lat: 40.48, lon: -88.92, population: 0.19, tier: 'regional' },
  { code: 'SGU', name: 'St George Regional', city: 'St George', country: 'US', lat: 37.04, lon: -113.51, population: 0.18, tier: 'regional' },
  { code: 'COU', name: 'Columbia Regional', city: 'Columbia', country: 'US', lat: 38.82, lon: -92.22, population: 0.18, tier: 'regional' },
  { code: 'RDD', name: 'Redding Regional', city: 'Redding', country: 'US', lat: 40.51, lon: -122.29, population: 0.18, tier: 'regional' },
  { code: 'ABI', name: 'Abilene Regional', city: 'Abilene', country: 'US', lat: 32.41, lon: -99.68, population: 0.17, tier: 'regional' },
  { code: 'BGR', name: 'Bangor Intl', city: 'Bangor', country: 'US', lat: 44.81, lon: -68.83, population: 0.15, tier: 'regional' },
  { code: 'ABY', name: 'Southwest Georgia Regional', city: 'Albany', country: 'US', lat: 31.54, lon: -84.19, population: 0.15, tier: 'regional' },
  { code: 'DHN', name: 'Dothan Regional', city: 'Dothan', country: 'US', lat: 31.32, lon: -85.45, population: 0.15, tier: 'regional' },
  { code: 'AEX', name: 'Alexandria Intl', city: 'Alexandria', country: 'US', lat: 31.33, lon: -92.55, population: 0.15, tier: 'regional' },
  { code: 'ACV', name: 'California Redwood Coast', city: 'Arcata', country: 'US', lat: 40.98, lon: -124.11, population: 0.13, tier: 'regional' },
  { code: 'BZN', name: 'Bozeman Yellowstone Intl', city: 'Bozeman', country: 'US', lat: 45.78, lon: -111.15, population: 0.12, visitors: 0.6, tier: 'regional' },
  { code: 'MEI', name: 'Key Field', city: 'Meridian', country: 'US', lat: 32.33, lon: -88.75, population: 0.1, tier: 'regional' },
  { code: 'CYS', name: 'Cheyenne Regional', city: 'Cheyenne', country: 'US', lat: 41.16, lon: -104.81, population: 0.1, tier: 'regional' },
  { code: 'BRD', name: 'Brainerd Lakes Regional', city: 'Brainerd', country: 'US', lat: 46.4, lon: -94.13, population: 0.06, visitors: 0.6, tier: 'regional' },
  { code: 'BET', name: 'Bethel', city: 'Bethel', country: 'US', lat: 60.78, lon: -161.84, population: 0.06, tier: 'regional' },
  { code: 'BJI', name: 'Bemidji Regional', city: 'Bemidji', country: 'US', lat: 47.51, lon: -94.93, population: 0.05, tier: 'regional' },
  { code: 'BFF', name: 'Western Nebraska Regional', city: 'Scottsbluff', country: 'US', lat: 41.87, lon: -103.6, population: 0.04, tier: 'regional' },
  { code: 'EYW', name: 'Key West Intl', city: 'Key West', country: 'US', lat: 24.55, lon: -81.76, population: 0.03, visitors: 0.6, tier: 'regional' },
  { code: 'SUN', name: 'Friedman Memorial', city: 'Sun Valley', country: 'US', lat: 43.5, lon: -114.3, population: 0.03, visitors: 0.6, tier: 'regional' },
  { code: 'HDN', name: 'Yampa Valley', city: 'Hayden', country: 'US', lat: 40.48, lon: -107.22, population: 0.03, visitors: 0.6, tier: 'regional' },
  { code: 'MVY', name: 'Martha\'s Vineyard', city: 'Martha\'s Vineyard', country: 'US', lat: 41.39, lon: -70.61, population: 0.02, visitors: 0.6, tier: 'regional' },
  { code: 'ACK', name: 'Nantucket Memorial', city: 'Nantucket', country: 'US', lat: 41.25, lon: -70.06, population: 0.02, visitors: 0.6, tier: 'regional' },
  { code: 'ADQ', name: 'Kodiak', city: 'Kodiak', country: 'US', lat: 57.75, lon: -152.49, population: 0.013, tier: 'regional' },
  { code: 'MMH', name: 'Mammoth Yosemite', city: 'Mammoth Lakes', country: 'US', lat: 37.62, lon: -118.84, population: 0.01, visitors: 0.6, tier: 'regional' },
  { code: 'DLG', name: 'Dillingham', city: 'Dillingham', country: 'US', lat: 59.04, lon: -158.5, population: 0.005, tier: 'regional' },
  { code: 'BRW', name: 'Wiley Post-Will Rogers', city: 'Utqiagvik', country: 'US', lat: 71.28, lon: -156.77, population: 0.005, tier: 'regional' },

  // ══════════════════════════════════════════════════════════════════════════
  // EXPANSION WAVE (2026-06-17) — 26 airports added via tools/airport-expansion
  // (tiered scorer: distinct + viable against the live gravity model)
  // ══════════════════════════════════════════════════════════════════════════
  // ── US ──
  { code: 'BUR', name: 'Hollywood Burbank', city: 'Burbank', country: 'US', lat: 34.2, lon: -118.36, population: 13.2, tier: 'major' },
  { code: 'AZA', name: 'Phoenix-Mesa Gateway', city: 'Mesa', country: 'US', lat: 33.31, lon: -111.66, population: 4.9, tier: 'regional' },
  { code: 'ONT', name: 'Ontario Intl', city: 'Ontario', country: 'US', lat: 34.06, lon: -117.6, population: 4.6, tier: 'regional' },
  { code: 'SNA', name: 'John Wayne Orange County', city: 'Santa Ana', country: 'US', lat: 33.68, lon: -117.87, population: 3.2, tier: 'regional' },
  { code: 'SFB', name: 'Orlando Sanford Intl', city: 'Sanford', country: 'US', lat: 28.78, lon: -81.24, population: 2.6, visitors: 0.3, tier: 'regional' },
  { code: 'PHF', name: 'Newport News/Williamsburg', city: 'Newport News', country: 'US', lat: 37.13, lon: -76.49, population: 1.7, tier: 'regional' },
  { code: 'PVD', name: 'T.F. Green', city: 'Providence', country: 'US', lat: 41.73, lon: -71.42, population: 1.6, tier: 'regional' },
  { code: 'PVU', name: 'Provo Municipal', city: 'Provo', country: 'US', lat: 40.22, lon: -111.72, population: 0.7, tier: 'regional' },
  { code: 'ORH', name: 'Worcester Regional', city: 'Worcester', country: 'US', lat: 42.27, lon: -71.87, population: 0.5, tier: 'regional' },
  { code: 'LAN', name: 'Capital Region Intl', city: 'Lansing', country: 'US', lat: 42.78, lon: -84.59, population: 0.46, tier: 'regional' },
  { code: 'GRK', name: 'Killeen-Fort Hood', city: 'Killeen', country: 'US', lat: 31.07, lon: -97.83, population: 0.45, tier: 'regional' },
  { code: 'MHT', name: 'Manchester-Boston Regional', city: 'Manchester', country: 'US', lat: 42.93, lon: -71.44, population: 0.42, tier: 'regional' },
  { code: 'BRO', name: 'Brownsville/South Padre', city: 'Brownsville', country: 'US', lat: 25.91, lon: -97.43, population: 0.42, tier: 'regional' },
  { code: 'MBS', name: 'MBS Intl', city: 'Saginaw', country: 'US', lat: 43.53, lon: -84.08, population: 0.4, tier: 'regional' },
  { code: 'APF', name: 'Naples Municipal', city: 'Naples', country: 'US', lat: 26.15, lon: -81.77, population: 0.4, visitors: 0.6, tier: 'regional' },
  { code: 'LBE', name: 'Arnold Palmer Regional', city: 'Latrobe', country: 'US', lat: 40.28, lon: -79.4, population: 0.3, tier: 'regional' },
  { code: 'SBP', name: 'San Luis Obispo Co. Regional', city: 'San Luis Obispo', country: 'US', lat: 35.24, lon: -120.64, population: 0.28, tier: 'regional' },
  { code: 'CMI', name: 'University of Illinois Willard', city: 'Champaign', country: 'US', lat: 40.04, lon: -88.28, population: 0.23, tier: 'regional' },
  { code: 'IAG', name: 'Niagara Falls Intl', city: 'Niagara Falls', country: 'US', lat: 43.1, lon: -78.95, population: 0.2, visitors: 0.6, tier: 'regional' },
  { code: 'PGD', name: 'Punta Gorda', city: 'Punta Gorda', country: 'US', lat: 26.92, lon: -81.99, population: 0.18, visitors: 0.6, tier: 'regional' },
  { code: 'SAF', name: 'Santa Fe Regional', city: 'Santa Fe', country: 'US', lat: 35.62, lon: -106.09, population: 0.15, visitors: 0.6, tier: 'regional' },
  { code: 'SPS', name: 'Wichita Falls Regional', city: 'Wichita Falls', country: 'US', lat: 33.99, lon: -98.49, population: 0.15, tier: 'regional' },
  { code: 'FLG', name: 'Flagstaff Pulliam', city: 'Flagstaff', country: 'US', lat: 35.14, lon: -111.67, population: 0.14, visitors: 0.6, tier: 'regional' },
  { code: 'BQK', name: 'Brunswick Golden Isles', city: 'Brunswick', country: 'US', lat: 31.26, lon: -81.47, population: 0.1, visitors: 0.6, tier: 'regional' },
  { code: 'HIB', name: 'Range Regional', city: 'Hibbing', country: 'US', lat: 47.39, lon: -92.84, population: 0.08, tier: 'regional' },
  { code: 'HHH', name: 'Hilton Head', city: 'Hilton Head', country: 'US', lat: 32.22, lon: -80.7, population: 0.05, visitors: 0.6, tier: 'regional' },

  // ══════════════════════════════════════════════════════════════════════════
  // EXPANSION WAVE (2026-06-17) — 75 airports added via tools/airport-expansion
  // (tiered scorer: distinct + viable against the live gravity model)
  // ══════════════════════════════════════════════════════════════════════════
  // ── US ──
  { code: 'YNG', name: 'Youngstown-Warren', city: 'Youngstown', country: 'US', lat: 41.26, lon: -80.67, population: 0.5, tier: 'regional' },
  { code: 'CRW', name: 'West Virginia Intl Yeager', city: 'Charleston', country: 'US', lat: 38.37, lon: -81.59, population: 0.25, tier: 'regional' },
  { code: 'MCN', name: 'Middle Georgia Regional', city: 'Macon', country: 'US', lat: 32.69, lon: -83.65, population: 0.23, tier: 'regional' },
  { code: 'LEB', name: 'Lebanon Municipal', city: 'Lebanon', country: 'US', lat: 43.63, lon: -72.3, population: 0.21, tier: 'regional' },
  { code: 'BWG', name: 'Bowling Green-Warren County', city: 'Bowling Green', country: 'US', lat: 36.96, lon: -86.42, population: 0.18, tier: 'regional' },
  { code: 'PGV', name: 'Pitt-Greenville', city: 'Greenville', country: 'US', lat: 35.64, lon: -77.39, population: 0.17, tier: 'regional' },
  { code: 'PIB', name: 'Hattiesburg-Laurel Regional', city: 'Hattiesburg', country: 'US', lat: 31.47, lon: -89.34, population: 0.17, tier: 'regional' },
  { code: 'VRB', name: 'Vero Beach Regional', city: 'Vero Beach', country: 'US', lat: 27.66, lon: -80.42, population: 0.16, visitors: 0.6, tier: 'regional' },
  { code: 'IFP', name: 'Laughlin/Bullhead Intl', city: 'Bullhead City', country: 'US', lat: 35.16, lon: -114.56, population: 0.15, visitors: 0.6, tier: 'regional' },
  { code: 'MSL', name: 'Northwest Alabama Regional', city: 'Muscle Shoals', country: 'US', lat: 34.74, lon: -87.61, population: 0.15, tier: 'regional' },
  { code: 'VIS', name: 'Visalia Municipal', city: 'Visalia', country: 'US', lat: 36.32, lon: -119.39, population: 0.14, tier: 'regional' },
  { code: 'JST', name: 'John Murtha Johnstown-Cambria', city: 'Johnstown', country: 'US', lat: 40.32, lon: -78.83, population: 0.13, tier: 'regional' },
  { code: 'JBR', name: 'Jonesboro Municipal', city: 'Jonesboro', country: 'US', lat: 35.83, lon: -90.65, population: 0.13, tier: 'regional' },
  { code: 'OWB', name: 'Owensboro-Daviess County', city: 'Owensboro', country: 'US', lat: 37.74, lon: -87.17, population: 0.12, tier: 'regional' },
  { code: 'FMN', name: 'Four Corners Regional', city: 'Farmington', country: 'US', lat: 36.74, lon: -108.23, population: 0.12, tier: 'regional' },
  { code: 'EAT', name: 'Pangborn Memorial', city: 'Wenatchee', country: 'US', lat: 47.4, lon: -120.21, population: 0.12, tier: 'regional' },
  { code: 'ART', name: 'Watertown Intl', city: 'Watertown', country: 'US', lat: 43.99, lon: -76.02, population: 0.11, tier: 'regional' },
  { code: 'OGS', name: 'Ogdensburg Intl', city: 'Ogdensburg', country: 'US', lat: 44.68, lon: -75.47, population: 0.11, tier: 'regional' },
  { code: 'BKW', name: 'Raleigh County Memorial', city: 'Beckley', country: 'US', lat: 37.79, lon: -81.12, population: 0.11, tier: 'regional' },
  { code: 'CIC', name: 'Chico Municipal', city: 'Chico', country: 'US', lat: 39.79, lon: -121.86, population: 0.11, tier: 'regional' },
  { code: 'DEC', name: 'Decatur Airport', city: 'Decatur', country: 'US', lat: 39.83, lon: -88.87, population: 0.105, tier: 'regional' },
  { code: 'PBG', name: 'Plattsburgh Intl', city: 'Plattsburgh', country: 'US', lat: 44.65, lon: -73.47, population: 0.08, tier: 'regional' },
  { code: 'SWO', name: 'Stillwater Regional', city: 'Stillwater', country: 'US', lat: 36.16, lon: -97.09, population: 0.08, tier: 'regional' },
  { code: 'PUW', name: 'Pullman-Moscow Regional', city: 'Pullman', country: 'US', lat: 46.74, lon: -117.11, population: 0.08, tier: 'regional' },
  { code: 'RUT', name: 'Rutland-Southern Vermont', city: 'Rutland', country: 'US', lat: 43.53, lon: -72.95, population: 0.06, visitors: 0.6, tier: 'regional' },
  { code: 'AUG', name: 'Augusta State', city: 'Augusta', country: 'US', lat: 44.32, lon: -69.8, population: 0.06, tier: 'regional' },
  { code: 'MWA', name: 'Veterans Williamson County', city: 'Marion', country: 'US', lat: 37.75, lon: -89.01, population: 0.06, tier: 'regional' },
  { code: 'CDC', name: 'Cedar City Regional', city: 'Cedar City', country: 'US', lat: 37.7, lon: -113.1, population: 0.06, tier: 'regional' },
  { code: 'ALW', name: 'Walla Walla Regional', city: 'Walla Walla', country: 'US', lat: 46.1, lon: -118.29, population: 0.06, tier: 'regional' },
  { code: 'LWS', name: 'Lewiston-Nez Perce County', city: 'Lewiston', country: 'US', lat: 46.37, lon: -117.02, population: 0.06, tier: 'regional' },
  { code: 'ENA', name: 'Kenai Municipal', city: 'Kenai', country: 'US', lat: 60.57, lon: -151.24, population: 0.06, tier: 'regional' },
  { code: 'HOB', name: 'Lea County Regional', city: 'Hobbs', country: 'US', lat: 32.69, lon: -103.22, population: 0.05, tier: 'regional' },
  { code: 'EKO', name: 'Elko Regional', city: 'Elko', country: 'US', lat: 40.82, lon: -115.79, population: 0.05, tier: 'regional' },
  { code: 'ROW', name: 'Roswell Air Center', city: 'Roswell', country: 'US', lat: 33.3, lon: -104.53, population: 0.05, tier: 'regional' },
  { code: 'LAR', name: 'Laramie Regional', city: 'Laramie', country: 'US', lat: 41.31, lon: -105.67, population: 0.05, tier: 'regional' },
  { code: 'GCC', name: 'Gillette-Campbell County', city: 'Gillette', country: 'US', lat: 44.35, lon: -105.54, population: 0.05, tier: 'regional' },
  { code: 'CMX', name: 'Houghton County Memorial', city: 'Hancock', country: 'US', lat: 47.17, lon: -88.49, population: 0.043, tier: 'regional' },
  { code: 'SLK', name: 'Adirondack Regional', city: 'Saranac Lake', country: 'US', lat: 44.39, lon: -74.21, population: 0.04, visitors: 0.6, tier: 'regional' },
  { code: 'RKD', name: 'Knox County Regional', city: 'Rockland', country: 'US', lat: 44.06, lon: -69.1, population: 0.04, visitors: 0.6, tier: 'regional' },
  { code: 'AOO', name: 'Altoona-Blair County', city: 'Altoona', country: 'US', lat: 40.3, lon: -78.32, population: 0.04, tier: 'regional' },
  { code: 'BFD', name: 'Bradford Regional', city: 'Bradford', country: 'US', lat: 41.8, lon: -78.64, population: 0.04, tier: 'regional' },
  { code: 'PQI', name: 'Presque Isle Intl', city: 'Presque Isle', country: 'US', lat: 46.69, lon: -68.04, population: 0.04, tier: 'regional' },
  { code: 'HRO', name: 'Boone County Regional', city: 'Harrison', country: 'US', lat: 36.26, lon: -93.15, population: 0.04, visitors: 0.6, tier: 'regional' },
  { code: 'LMT', name: 'Crater Lake-Klamath Regional', city: 'Klamath Falls', country: 'US', lat: 42.16, lon: -121.73, population: 0.04, visitors: 0.6, tier: 'regional' },
  { code: 'UIN', name: 'Quincy Regional', city: 'Quincy', country: 'US', lat: 39.94, lon: -91.19, population: 0.04, tier: 'regional' },
  { code: 'GLH', name: 'Mid Delta Regional', city: 'Greenville', country: 'US', lat: 33.48, lon: -90.99, population: 0.04, tier: 'regional' },
  { code: 'EAR', name: 'Kearney Regional', city: 'Kearney', country: 'US', lat: 40.73, lon: -99.01, population: 0.034, tier: 'regional' },
  { code: 'LWB', name: 'Greenbrier Valley', city: 'Lewisburg', country: 'US', lat: 37.86, lon: -80.4, population: 0.03, visitors: 0.6, tier: 'regional' },
  { code: 'CEZ', name: 'Cortez Municipal', city: 'Cortez', country: 'US', lat: 37.3, lon: -108.63, population: 0.03, visitors: 0.6, tier: 'regional' },
  { code: 'OTH', name: 'Southwest Oregon Regional', city: 'North Bend', country: 'US', lat: 43.42, lon: -124.25, population: 0.03, visitors: 0.6, tier: 'regional' },
  { code: 'PDT', name: 'Eastern Oregon Regional', city: 'Pendleton', country: 'US', lat: 45.7, lon: -118.84, population: 0.03, tier: 'regional' },
  { code: 'SHR', name: 'Sheridan County', city: 'Sheridan', country: 'US', lat: 44.77, lon: -106.98, population: 0.03, tier: 'regional' },
  { code: 'APN', name: 'Alpena County Regional', city: 'Alpena', country: 'US', lat: 45.08, lon: -83.56, population: 0.029, tier: 'regional' },
  { code: 'DDC', name: 'Dodge City Regional', city: 'Dodge City', country: 'US', lat: 37.76, lon: -99.97, population: 0.027, tier: 'regional' },
  { code: 'BRL', name: 'Southeast Iowa Regional', city: 'Burlington', country: 'US', lat: 40.78, lon: -91.13, population: 0.025, tier: 'regional' },
  { code: 'OTM', name: 'Ottumwa Regional', city: 'Ottumwa', country: 'US', lat: 41.11, lon: -92.45, population: 0.025, tier: 'regional' },
  { code: 'OFK', name: 'Norfolk Regional', city: 'Norfolk', country: 'US', lat: 41.99, lon: -97.43, population: 0.025, tier: 'regional' },
  { code: 'FOD', name: 'Fort Dodge Regional', city: 'Fort Dodge', country: 'US', lat: 42.55, lon: -94.19, population: 0.024, tier: 'regional' },
  { code: 'HYS', name: 'Hays Regional', city: 'Hays', country: 'US', lat: 38.84, lon: -99.27, population: 0.021, tier: 'regional' },
  { code: 'SOW', name: 'Show Low Regional', city: 'Show Low', country: 'US', lat: 34.27, lon: -110.01, population: 0.02, visitors: 0.6, tier: 'regional' },
  { code: 'ATY', name: 'Watertown Regional', city: 'Watertown', country: 'US', lat: 44.91, lon: -97.15, population: 0.02, tier: 'regional' },
  { code: 'LBL', name: 'Liberal Mid-America', city: 'Liberal', country: 'US', lat: 37.04, lon: -100.96, population: 0.02, tier: 'regional' },
  { code: 'ALS', name: 'San Luis Valley Regional', city: 'Alamosa', country: 'US', lat: 37.43, lon: -105.87, population: 0.02, tier: 'regional' },
  { code: 'CIU', name: 'Chippewa County Intl', city: 'Sault Ste Marie', country: 'US', lat: 46.25, lon: -84.47, population: 0.014, tier: 'regional' },
  { code: 'SPW', name: 'Spencer Municipal', city: 'Spencer', country: 'US', lat: 43.17, lon: -95.2, population: 0.011, tier: 'regional' },
  { code: 'DVL', name: 'Devils Lake Regional', city: 'Devils Lake', country: 'US', lat: 48.11, lon: -98.91, population: 0.007, tier: 'regional' },
  { code: 'MCK', name: 'McCook Ben Nelson Regional', city: 'McCook', country: 'US', lat: 40.21, lon: -100.59, population: 0.007, tier: 'regional' },
  { code: 'SDY', name: 'Sidney-Richland', city: 'Sidney', country: 'US', lat: 47.71, lon: -104.19, population: 0.006, tier: 'regional' },
  { code: 'BHB', name: 'Hancock County-Bar Harbor', city: 'Bar Harbor', country: 'US', lat: 44.45, lon: -68.36, population: 0.005, visitors: 0.6, tier: 'regional' },
  { code: 'PLN', name: 'Pellston Regional', city: 'Pellston', country: 'US', lat: 45.57, lon: -84.8, population: 0.005, visitors: 0.6, tier: 'regional' },
  { code: 'DUT', name: 'Unalaska', city: 'Dutch Harbor', country: 'US', lat: 53.9, lon: -166.54, population: 0.005, tier: 'regional' },
  { code: 'GDV', name: 'Dawson Community', city: 'Glendive', country: 'US', lat: 47.14, lon: -104.81, population: 0.004, tier: 'regional' },
  { code: 'VDZ', name: 'Valdez', city: 'Valdez', country: 'US', lat: 61.13, lon: -146.25, population: 0.004, visitors: 0.6, tier: 'regional' },
  { code: 'OLF', name: 'L.M. Clayton', city: 'Wolf Point', country: 'US', lat: 48.09, lon: -105.57, population: 0.003, tier: 'regional' },
  { code: 'GGW', name: 'Wokal Field Glasgow', city: 'Glasgow', country: 'US', lat: 48.21, lon: -106.61, population: 0.003, tier: 'regional' },
];

export function getAirport(code) {
  return AIRPORTS.find(a => a.code === code);
}

// ─── Gate pricing ──────────────────────────────────────────────────────────────

/** Monthly gate rental cost by airport tier. */
export const GATE_FEE_BY_TIER = {
  mega:     120_000,   // LHR, JFK, ORD, ATL, DFW, FRA, AMS …
  major:     70_000,   // SFO, MIA, BOS, ZRH …
  regional:  30_000,   // smaller city airports
};

/**
 * Marginal cost escalation per additional gate.
 * Each gate costs this much MORE (proportionally) than the previous one.
 * mega: +10% / gate, major: +5% / gate, regional: +2% / gate.
 */
export const GATE_COST_ESCALATION = {
  mega:     1.10,
  major:    1.05,
  regional: 1.02,
};

/**
 * Monthly fee for the Nth gate at an airport (1-indexed).
 * Gate 1 = base rate; gate 2 = base × escalation; gate N = base × escalation^(N-1).
 *
 * @param {object} airport  - airport record from AIRPORTS
 * @param {number} [n=1]    - which gate number (1 = first gate)
 */
export function gateMonthlyFee(airport, n = 1) {
  const base = GATE_FEE_BY_TIER[airport?.tier] ?? 50_000;
  const rate = GATE_COST_ESCALATION[airport?.tier] ?? 1.05;
  return Math.round(base * Math.pow(rate, n - 1));
}

/**
 * Total monthly cost for holding `count` gates at an airport.
 * = sum of gateMonthlyFee(airport, 1..count)
 * = base × (rate^count − 1) / (rate − 1)   when rate ≠ 1
 *
 * @param {object} airport  - airport record from AIRPORTS
 * @param {number} count    - number of gates held
 */
export function totalGateMonthlyFee(airport, count) {
  if (!count || count <= 0) return 0;
  const base = GATE_FEE_BY_TIER[airport?.tier] ?? 50_000;
  const rate = GATE_COST_ESCALATION[airport?.tier] ?? 1.05;
  if (rate === 1) return base * count;
  return Math.round(base * (Math.pow(rate, count) - 1) / (rate - 1));
}

// ─── Per-airport business / leisure scores ─────────────────────────────────────
//
// businessScore (0–100): how corporate/premium-oriented this airport is.
//   High = lots of suits flying in for meetings.
// leisureScore  (0–100): how tourism/holiday-oriented this airport is.
//   High = beach bags and selfie sticks. These are INDEPENDENT — a big mixed
//   hub like JFK can score well on both; a tiny ski resort scores low on both.
//
// Unlisted airports fall back to getAirportScores() which uses tier defaults.

export const AIRPORT_SCORES = {
  // ── North America – major hubs ──────────────────────────────────────────────
  JFK: { businessScore: 72, leisureScore: 65 },   // finance capital + global tourism
  LAX: { businessScore: 62, leisureScore: 72 },   // entertainment industry + sunshine tourism
  ORD: { businessScore: 68, leisureScore: 40 },   // Midwest business hub
  ATL: { businessScore: 65, leisureScore: 45 },
  DFW: { businessScore: 65, leisureScore: 38 },
  DEN: { businessScore: 58, leisureScore: 55 },   // ski + business
  SFO: { businessScore: 72, leisureScore: 58 },   // tech corridor + Golden Gate tourism
  SEA: { businessScore: 65, leisureScore: 55 },   // tech hub (Amazon/Boeing)
  MIA: { businessScore: 60, leisureScore: 68 },   // trade hub + beach
  BOS: { businessScore: 70, leisureScore: 52 },   // academia / finance
  PHX: { businessScore: 55, leisureScore: 50 },
  IAD: { businessScore: 78, leisureScore: 28 },   // DC govt/defense – low leisure
  DCA: { businessScore: 82, leisureScore: 30 },   // Reagan National – premium business/govt shuttle
  IAH: { businessScore: 65, leisureScore: 38 },   // Houston energy sector
  MSP: { businessScore: 60, leisureScore: 40 },
  DTW: { businessScore: 62, leisureScore: 38 },
  PHL: { businessScore: 62, leisureScore: 40 },
  CLT: { businessScore: 60, leisureScore: 40 },
  EWR: { businessScore: 68, leisureScore: 55 },   // NYC metro overflow
  LGA: { businessScore: 70, leisureScore: 50 },   // NYC shuttle – heavy business

  // ── North America – leisure ─────────────────────────────────────────────────
  LAS: { businessScore: 15, leisureScore: 90 },   // Vegas – conventions exist but it's leisure
  MCO: { businessScore: 12, leisureScore: 92 },   // Orlando – Disney/Universal
  HNL: { businessScore: 18, leisureScore: 88 },   // Honolulu
  OGG: { businessScore:  5, leisureScore: 96 },   // Maui – pure resort
  KOA: { businessScore:  5, leisureScore: 96 },   // Kona – pure resort
  FLL: { businessScore: 20, leisureScore: 80 },
  TPA: { businessScore: 28, leisureScore: 65 },
  PBI: { businessScore: 22, leisureScore: 72 },   // Palm Beach – wealthy leisure
  SJU: { businessScore: 30, leisureScore: 72 },   // San Juan – mixed
  ANC: { businessScore: 35, leisureScore: 55 },   // Anchorage – resource sector

  // ── Canada ──────────────────────────────────────────────────────────────────
  YYZ: { businessScore: 65, leisureScore: 48 },
  YVR: { businessScore: 60, leisureScore: 62 },   // gateway + scenic
  YUL: { businessScore: 62, leisureScore: 52 },

  // ── Mexico / Central America ────────────────────────────────────────────────
  MEX: { businessScore: 65, leisureScore: 55 },
  CUN: { businessScore:  8, leisureScore: 92 },   // Cancún – resort town
  GDL: { businessScore: 55, leisureScore: 50 },
  PTY: { businessScore: 55, leisureScore: 55 },   // Panama City – regional hub

  // ── Caribbean ───────────────────────────────────────────────────────────────
  MBJ: { businessScore:  5, leisureScore: 94 },
  NAS: { businessScore:  8, leisureScore: 92 },
  BGI: { businessScore:  5, leisureScore: 94 },
  SXM: { businessScore:  5, leisureScore: 96 },
  GCM: { businessScore: 10, leisureScore: 90 },
  SDQ: { businessScore: 20, leisureScore: 78 },
  POS: { businessScore: 35, leisureScore: 62 },   // Port of Spain – energy/trade
  HAV: { businessScore: 20, leisureScore: 80 },

  // ── South America ────────────────────────────────────────────────────────────
  GRU: { businessScore: 65, leisureScore: 52 },
  GIG: { businessScore: 48, leisureScore: 75 },   // Rio de Janeiro – tourism
  EZE: { businessScore: 62, leisureScore: 55 },
  SCL: { businessScore: 60, leisureScore: 52 },
  BOG: { businessScore: 62, leisureScore: 45 },
  LIM: { businessScore: 58, leisureScore: 50 },
  MDE: { businessScore: 55, leisureScore: 52 },
  CLO: { businessScore: 50, leisureScore: 48 },

  // ── Europe – major hubs ──────────────────────────────────────────────────────
  LHR: { businessScore: 82, leisureScore: 55 },   // global finance + heavy tourism
  CDG: { businessScore: 75, leisureScore: 65 },   // Paris – business + #1 tourist city
  FRA: { businessScore: 88, leisureScore: 28 },   // financial/industrial – low leisure
  AMS: { businessScore: 78, leisureScore: 55 },
  MAD: { businessScore: 65, leisureScore: 62 },
  BCN: { businessScore: 48, leisureScore: 72 },   // Barcelona – tourism dominant
  FCO: { businessScore: 55, leisureScore: 68 },   // Rome – tourist city
  MXP: { businessScore: 68, leisureScore: 50 },   // Milan – fashion/industry
  MUC: { businessScore: 72, leisureScore: 48 },
  ZRH: { businessScore: 85, leisureScore: 35 },   // banking capital
  VIE: { businessScore: 68, leisureScore: 52 },
  BRU: { businessScore: 75, leisureScore: 38 },   // EU institutions
  LIS: { businessScore: 50, leisureScore: 72 },   // Lisbon – growing tourism
  OSL: { businessScore: 65, leisureScore: 40 },   // oil industry
  ARN: { businessScore: 65, leisureScore: 48 },
  HEL: { businessScore: 62, leisureScore: 45 },
  CPH: { businessScore: 68, leisureScore: 52 },
  DUB: { businessScore: 65, leisureScore: 60 },   // tech (Google/Facebook EMEA) + tourism
  WAW: { businessScore: 60, leisureScore: 40 },
  ATH: { businessScore: 45, leisureScore: 72 },   // shipping business + lots of tourists
  IST: { businessScore: 68, leisureScore: 62 },
  BER: { businessScore: 62, leisureScore: 58 },
  LGW: { businessScore: 45, leisureScore: 72 },   // Gatwick – budget/leisure flights
  LCY: { businessScore: 90, leisureScore: 20 },   // London City – Canary Wharf/finance, almost pure business
  MAN: { businessScore: 58, leisureScore: 60 },
  LYS: { businessScore: 58, leisureScore: 50 },
  NCE: { businessScore: 32, leisureScore: 75 },   // Nice – Riviera leisure
  PRG: { businessScore: 48, leisureScore: 72 },   // Prague – high tourism
  BUD: { businessScore: 50, leisureScore: 68 },
  OTP: { businessScore: 50, leisureScore: 55 },
  SAW: { businessScore: 42, leisureScore: 65 },   // Istanbul Sabiha – leisure/budget

  // ── Europe – beach / leisure ─────────────────────────────────────────────────
  PMI: { businessScore:  8, leisureScore: 92 },   // Palma – Balearic beach
  IBZ: { businessScore:  6, leisureScore: 95 },   // Ibiza
  TFS: { businessScore:  6, leisureScore: 92 },   // Tenerife South
  LPA: { businessScore:  6, leisureScore: 92 },   // Gran Canaria
  AGP: { businessScore:  8, leisureScore: 90 },   // Malaga / Costa del Sol
  FAO: { businessScore:  8, leisureScore: 90 },   // Algarve
  FNC: { businessScore:  6, leisureScore: 90 },   // Madeira
  HER: { businessScore:  5, leisureScore: 93 },   // Heraklion – Crete
  RHO: { businessScore:  5, leisureScore: 93 },   // Rhodes
  JTR: { businessScore:  5, leisureScore: 95 },   // Santorini
  JMK: { businessScore:  4, leisureScore: 96 },   // Mykonos
  CHQ: { businessScore:  5, leisureScore: 92 },   // Chania
  AYT: { businessScore:  7, leisureScore: 92 },   // Antalya
  DLM: { businessScore:  5, leisureScore: 92 },   // Dalaman
  DBV: { businessScore:  7, leisureScore: 93 },   // Dubrovnik
  SPU: { businessScore:  5, leisureScore: 90 },   // Split
  SSH: { businessScore:  5, leisureScore: 92 },   // Sharm el-Sheikh
  HRG: { businessScore:  5, leisureScore: 92 },   // Hurghada

  // ── Middle East ──────────────────────────────────────────────────────────────
  DXB: { businessScore: 80, leisureScore: 65 },   // Dubai – corporate AND shopping/tourism
  DOH: { businessScore: 78, leisureScore: 55 },
  AUH: { businessScore: 75, leisureScore: 58 },
  RUH: { businessScore: 72, leisureScore: 28 },   // Riyadh – restrictive, minimal leisure
  JED: { businessScore: 60, leisureScore: 52 },   // Jeddah – religious + business
  MCT: { businessScore: 58, leisureScore: 55 },

  // ── Africa ───────────────────────────────────────────────────────────────────
  JNB: { businessScore: 62, leisureScore: 50 },
  CPT: { businessScore: 48, leisureScore: 75 },   // Cape Town – major tourism
  CAI: { businessScore: 55, leisureScore: 58 },
  NBO: { businessScore: 58, leisureScore: 45 },
  LOS: { businessScore: 62, leisureScore: 38 },   // Lagos – commercial capital
  CMN: { businessScore: 50, leisureScore: 55 },
  ADD: { businessScore: 52, leisureScore: 42 },

  // ── South & Southeast Asia ───────────────────────────────────────────────────
  SIN: { businessScore: 78, leisureScore: 62 },
  HKG: { businessScore: 82, leisureScore: 58 },
  KUL: { businessScore: 62, leisureScore: 58 },
  BKK: { businessScore: 50, leisureScore: 78 },   // Bangkok – tourism dominant
  CGK: { businessScore: 55, leisureScore: 55 },
  MNL: { businessScore: 52, leisureScore: 58 },
  DEL: { businessScore: 62, leisureScore: 48 },
  BOM: { businessScore: 65, leisureScore: 50 },
  BLR: { businessScore: 72, leisureScore: 38 },   // Bangalore – IT hub
  CMB: { businessScore: 40, leisureScore: 62 },

  // ── East Asia ────────────────────────────────────────────────────────────────
  NRT: { businessScore: 68, leisureScore: 65 },
  HND: { businessScore: 72, leisureScore: 62 },   // Haneda – more domestic/business
  KIX: { businessScore: 58, leisureScore: 62 },
  ICN: { businessScore: 72, leisureScore: 62 },
  PEK: { businessScore: 65, leisureScore: 52 },
  PVG: { businessScore: 72, leisureScore: 58 },
  CAN: { businessScore: 65, leisureScore: 50 },
  TPE: { businessScore: 68, leisureScore: 58 },

  // ── Oceania ──────────────────────────────────────────────────────────────────
  SYD: { businessScore: 65, leisureScore: 72 },   // big business city + iconic tourism
  MEL: { businessScore: 65, leisureScore: 65 },
  BNE: { businessScore: 55, leisureScore: 65 },
  AKL: { businessScore: 58, leisureScore: 68 },

  // ── Expansion: scored additions ──────────────────────────────────────────────
  NTG: { businessScore: 48, leisureScore: 38 },   // Nantong – Yangtze industrial
  WUX: { businessScore: 52, leisureScore: 42 },   // Wuxi – tech/manufacturing
  ZHA: { businessScore: 42, leisureScore: 45 },   // Zhanjiang – port city
  SWA: { businessScore: 45, leisureScore: 45 },   // Shantou – SEZ
  DYG: { businessScore: 10, leisureScore: 92 },   // Zhangjiajie – scenery tourism
  JHG: { businessScore: 12, leisureScore: 85 },   // Xishuangbanna – tropical tourism
  UDR: { businessScore: 18, leisureScore: 85 },   // Udaipur – heritage tourism
  URT: { businessScore: 30, leisureScore: 60 },   // Surat Thani – Samui gateway
  CXR: { businessScore: 15, leisureScore: 88 },   // Nha Trang – beach resort
  LPQ: { businessScore: 10, leisureScore: 88 },   // Luang Prabang – heritage tourism
  CGY: { businessScore: 38, leisureScore: 48 },   // Cagayan de Oro
  BDO: { businessScore: 45, leisureScore: 50 },   // Bandung – diversified metro
  PNK: { businessScore: 35, leisureScore: 45 },   // Pontianak
  KOE: { businessScore: 30, leisureScore: 45 },   // Kupang
  AMQ: { businessScore: 28, leisureScore: 50 },   // Ambon
  DJJ: { businessScore: 32, leisureScore: 40 },   // Jayapura
  RAK: { businessScore: 25, leisureScore: 88 },   // Marrakesh – tourism
  SKD: { businessScore: 15, leisureScore: 85 },   // Samarkand – Silk Road tourism
  AUA: { businessScore: 12, leisureScore: 92 },   // Aruba – beach resort

  // ── Expansion: iconic / novelty ──────────────────────────────────────────────
  DIL: { businessScore: 32, leisureScore: 45 },   // Dili
  PBH: { businessScore: 20, leisureScore: 80 },   // Paro
  USH: { businessScore: 20, leisureScore: 80 },   // Ushuaia
  FAE: { businessScore: 25, leisureScore: 70 },   // Vagar / Faroe
  GOH: { businessScore: 35, leisureScore: 55 },   // Nuuk
  DCY: { businessScore: 10, leisureScore: 90 },   // Daocheng Yading
  BPX: { businessScore: 20, leisureScore: 55 },   // Qamdo Bamda
  LUA: { businessScore: 10, leisureScore: 90 },   // Lukla
  HGU: { businessScore: 32, leisureScore: 40 },   // Mount Hagen
  PPG: { businessScore: 30, leisureScore: 55 },   // Pago Pago
  IPC: { businessScore: 8,  leisureScore: 92 },   // Easter Island
  INU: { businessScore: 30, leisureScore: 40 },   // Nauru
  GIS: { businessScore: 32, leisureScore: 45 },   // Gisborne
  FSP: { businessScore: 30, leisureScore: 40 },   // St-Pierre
  MNK: { businessScore: 28, leisureScore: 55 },   // Maumere
  BRR: { businessScore: 10, leisureScore: 85 },   // Barra
  LYR: { businessScore: 20, leisureScore: 80 },   // Longyearbyen
  HLE: { businessScore: 15, leisureScore: 80 },   // St Helena
  SAB: { businessScore: 10, leisureScore: 90 },   // Saba
  SBH: { businessScore: 20, leisureScore: 90 },   // St Barthelemy
  GIB: { businessScore: 30, leisureScore: 70 },   // Gibraltar
  CVF: { businessScore: 15, leisureScore: 90 },   // Courchevel
  SFJ: { businessScore: 20, leisureScore: 70 },   // Kangerlussuaq
  NLK: { businessScore: 15, leisureScore: 75 },   // Norfolk Island
  AXA: { businessScore: 20, leisureScore: 85 },   // Anguilla
  VQS: { businessScore: 15, leisureScore: 80 },   // Vieques
  SDU: { businessScore: 60, leisureScore: 50 },   // Santos Dumont (downtown Rio)

  // ── Expansion: UN member coverage ────────────────────────────────────────────
  BJM: { businessScore: 30, leisureScore: 35 },   // Bujumbura
  HAH: { businessScore: 25, leisureScore: 45 },   // Moroni
  DOM: { businessScore: 20, leisureScore: 70 },   // Dominica
  SSG: { businessScore: 40, leisureScore: 35 },   // Malabo
  SHO: { businessScore: 28, leisureScore: 40 },   // Eswatini
  CKY: { businessScore: 35, leisureScore: 35 },   // Conakry
  PAP: { businessScore: 32, leisureScore: 35 },   // Port-au-Prince
  FNJ: { businessScore: 30, leisureScore: 30 },   // Pyongyang
  MSU: { businessScore: 28, leisureScore: 38 },   // Maseru
  ROB: { businessScore: 32, leisureScore: 35 },   // Monrovia
  MLE: { businessScore: 30, leisureScore: 85 },   // Male / Maldives
  MAJ: { businessScore: 25, leisureScore: 45 },   // Majuro
  PNI: { businessScore: 25, leisureScore: 45 },   // Pohnpei
  ULN: { businessScore: 45, leisureScore: 45 },   // Ulaanbaatar
  ROR: { businessScore: 25, leisureScore: 55 },   // Koror / Palau
  UVF: { businessScore: 25, leisureScore: 70 },   // Saint Lucia
  SVD: { businessScore: 25, leisureScore: 65 },   // St Vincent
  FNA: { businessScore: 32, leisureScore: 38 },   // Freetown
  JUB: { businessScore: 30, leisureScore: 30 },   // Juba
  DAM: { businessScore: 40, leisureScore: 35 },   // Damascus
  FUN: { businessScore: 20, leisureScore: 45 },   // Funafuti / Tuvalu

  // ── Expansion: 1500 build — explicit scores for leisure destinations ─────────
  JOG: { businessScore: 16, leisureScore: 88 },
  KWL: { businessScore: 16, leisureScore: 88 },
  CDE: { businessScore: 16, leisureScore: 88 },
  BPE: { businessScore: 16, leisureScore: 88 },
  JDZ: { businessScore: 16, leisureScore: 88 },
  TXN: { businessScore: 16, leisureScore: 88 },
  SXR: { businessScore: 16, leisureScore: 88 },
  AVA: { businessScore: 16, leisureScore: 88 },
  BHY: { businessScore: 16, leisureScore: 88 },
  IXD: { businessScore: 16, leisureScore: 88 },
  JDH: { businessScore: 16, leisureScore: 88 },
  DED: { businessScore: 16, leisureScore: 88 },
  DNZ: { businessScore: 16, leisureScore: 88 },
  RKZ: { businessScore: 16, leisureScore: 88 },
  MYQ: { businessScore: 16, leisureScore: 88 },
  GAY: { businessScore: 16, leisureScore: 88 },
  PKR: { businessScore: 16, leisureScore: 88 },
  BAR: { businessScore: 16, leisureScore: 88 },
  TJQ: { businessScore: 16, leisureScore: 88 },
  DLU: { businessScore: 16, leisureScore: 88 },
  LUM: { businessScore: 16, leisureScore: 88 },
  HKD: { businessScore: 16, leisureScore: 88 },
  TTR: { businessScore: 16, leisureScore: 88 },
  BWA: { businessScore: 16, leisureScore: 88 },
  VAR: { businessScore: 16, leisureScore: 88 },
  TIR: { businessScore: 16, leisureScore: 88 },
  HUN: { businessScore: 16, leisureScore: 88 },
  WUS: { businessScore: 16, leisureScore: 88 },
  DLI: { businessScore: 16, leisureScore: 88 },
  SBZ: { businessScore: 16, leisureScore: 88 },
  SLA: { businessScore: 16, leisureScore: 88 },
  YNY: { businessScore: 16, leisureScore: 88 },
  BOJ: { businessScore: 16, leisureScore: 88 },
  HLD: { businessScore: 16, leisureScore: 88 },
  SDT: { businessScore: 16, leisureScore: 88 },
  LDE: { businessScore: 16, leisureScore: 88 },
  NAV: { businessScore: 16, leisureScore: 88 },
  GIL: { businessScore: 16, leisureScore: 88 },
  BHK: { businessScore: 16, leisureScore: 88 },
  NLT: { businessScore: 16, leisureScore: 88 },
  SMR: { businessScore: 16, leisureScore: 88 },
  CXB: { businessScore: 16, leisureScore: 88 },
  LZY: { businessScore: 16, leisureScore: 88 },
  AXM: { businessScore: 16, leisureScore: 88 },
  NLH: { businessScore: 16, leisureScore: 88 },
  KUU: { businessScore: 16, leisureScore: 88 },
  DHM: { businessScore: 16, leisureScore: 88 },
  MMB: { businessScore: 16, leisureScore: 88 },
  CEI: { businessScore: 16, leisureScore: 88 },
  LGP: { businessScore: 16, leisureScore: 88 },
  PKC: { businessScore: 16, leisureScore: 88 },
  UGC: { businessScore: 16, leisureScore: 88 },
  VDH: { businessScore: 16, leisureScore: 88 },
  IOS: { businessScore: 16, leisureScore: 88 },
  DNH: { businessScore: 16, leisureScore: 88 },
  DTB: { businessScore: 16, leisureScore: 88 },
  KVA: { businessScore: 16, leisureScore: 88 },
  JUL: { businessScore: 16, leisureScore: 88 },
  AAT: { businessScore: 16, leisureScore: 88 },
  MZG: { businessScore: 16, leisureScore: 88 },
  BPS: { businessScore: 16, leisureScore: 88 },
  LGK: { businessScore: 16, leisureScore: 88 },
  JSA: { businessScore: 16, leisureScore: 88 },
  ZBR: { businessScore: 16, leisureScore: 88 },
  DIG: { businessScore: 16, leisureScore: 88 },
  ZAD: { businessScore: 16, leisureScore: 88 },
  BUS: { businessScore: 16, leisureScore: 88 },
  TMC: { businessScore: 16, leisureScore: 88 },
  KGT: { businessScore: 16, leisureScore: 88 },
  LAO: { businessScore: 16, leisureScore: 88 },
  HEH: { businessScore: 16, leisureScore: 88 },
  ETM: { businessScore: 16, leisureScore: 88 },
  KDU: { businessScore: 16, leisureScore: 88 },
  DOL: { businessScore: 16, leisureScore: 88 },
  EGC: { businessScore: 16, leisureScore: 88 },
  ABT: { businessScore: 16, leisureScore: 88 },
  WGP: { businessScore: 16, leisureScore: 88 },
  JZH: { businessScore: 16, leisureScore: 88 },
  BRC: { businessScore: 16, leisureScore: 88 },
  CJL: { businessScore: 16, leisureScore: 88 },
  DIU: { businessScore: 16, leisureScore: 88 },
  HRI: { businessScore: 16, leisureScore: 88 },
  LBJ: { businessScore: 16, leisureScore: 88 },
  KIH: { businessScore: 16, leisureScore: 88 },
  ULH: { businessScore: 16, leisureScore: 88 },
  PLQ: { businessScore: 16, leisureScore: 88 },
  NYU: { businessScore: 16, leisureScore: 88 },
  KRW: { businessScore: 16, leisureScore: 88 },
  EJH: { businessScore: 16, leisureScore: 88 },
  TOS: { businessScore: 16, leisureScore: 88 },
  PUQ: { businessScore: 16, leisureScore: 88 },
  USU: { businessScore: 16, leisureScore: 88 },
  PVK: { businessScore: 16, leisureScore: 88 },
  TAT: { businessScore: 16, leisureScore: 88 },
  KJI: { businessScore: 16, leisureScore: 88 },
  OSD: { businessScore: 16, leisureScore: 88 },
  SPC: { businessScore: 16, leisureScore: 88 },
  RVN: { businessScore: 16, leisureScore: 88 },
  ADZ: { businessScore: 16, leisureScore: 88 },
  ZTH: { businessScore: 16, leisureScore: 88 },
  EFL: { businessScore: 16, leisureScore: 88 },
  TER: { businessScore: 16, leisureScore: 88 },
  VBY: { businessScore: 16, leisureScore: 88 },
  AEY: { businessScore: 16, leisureScore: 88 },
  KRN: { businessScore: 16, leisureScore: 88 },
  FTE: { businessScore: 16, leisureScore: 88 },
  ALF: { businessScore: 16, leisureScore: 88 },
  AOK: { businessScore: 16, leisureScore: 88 },
  JSI: { businessScore: 16, leisureScore: 88 },
  AGX: { businessScore: 16, leisureScore: 88 },
  IVL: { businessScore: 16, leisureScore: 88 },
  KKN: { businessScore: 16, leisureScore: 88 },
  HOR: { businessScore: 16, leisureScore: 88 },
  MLO: { businessScore: 16, leisureScore: 88 },
};

// ── Region mapping ────────────────────────────────────────────────────────────
// Maps ISO country codes to display region names.
export const COUNTRY_REGION = {
  // North America (includes Central America & Caribbean)
  US: 'North America', CA: 'North America', MX: 'North America',
  PA: 'North America', CU: 'North America', DO: 'North America',
  JM: 'North America', BS: 'North America', BB: 'North America',
  SX: 'North America', TT: 'North America', KY: 'North America',
  BM: 'North America', SV: 'North America', GT: 'North America',
  HN: 'North America', NI: 'North America', CR: 'North America',
  PR: 'North America',
  // South America
  BR: 'South America', AR: 'South America', CL: 'South America',
  CO: 'South America', PE: 'South America', EC: 'South America',
  PY: 'South America', UY: 'South America', VE: 'South America',
  BO: 'South America', CW: 'South America', SR: 'South America',
  AW: 'South America',
  // Expansion: iconic territories + UN member coverage
  TL: 'Asia', BT: 'Asia', KP: 'Asia', MV: 'Asia', MN: 'Asia',
  FO: 'Europe', GI: 'Europe',
  GL: 'North America', PM: 'North America', BQ: 'North America', BL: 'North America',
  AI: 'North America', DM: 'North America', HT: 'North America', LC: 'North America',
  VC: 'North America',
  AS: 'Oceania', NR: 'Oceania', NF: 'Oceania', MH: 'Oceania', FM: 'Oceania',
  PW: 'Oceania', TV: 'Oceania',
  SH: 'Africa', BI: 'Africa', KM: 'Africa', GQ: 'Africa', SZ: 'Africa',
  GN: 'Africa', LS: 'Africa', LR: 'Africa', SL: 'Africa', SS: 'Africa',
  SY: 'Middle East',
  GY: 'South America',
  // Europe
  GB: 'Europe', FR: 'Europe', DE: 'Europe', NL: 'Europe',
  ES: 'Europe', IT: 'Europe', CH: 'Europe', AT: 'Europe',
  BE: 'Europe', PT: 'Europe', NO: 'Europe', SE: 'Europe',
  FI: 'Europe', DK: 'Europe', IE: 'Europe', PL: 'Europe',
  GR: 'Europe', TR: 'Europe', CZ: 'Europe', HU: 'Europe',
  RO: 'Europe', BG: 'Europe', HR: 'Europe', RS: 'Europe',
  SI: 'Europe', MK: 'Europe', AL: 'Europe', SK: 'Europe',
  UA: 'Europe', BY: 'Europe', EE: 'Europe', LV: 'Europe',
  LT: 'Europe', RU: 'Europe', IS: 'Europe',
  // Middle East & Central Asia
  AE: 'Middle East', QA: 'Middle East', SA: 'Middle East',
  IL: 'Middle East', KW: 'Middle East', BH: 'Middle East',
  OM: 'Middle East', LB: 'Middle East', JO: 'Middle East',
  IQ: 'Middle East', IR: 'Middle East', AZ: 'Middle East',
  GE: 'Middle East', AM: 'Middle East', UZ: 'Middle East',
  KZ: 'Middle East', KG: 'Middle East', TM: 'Middle East',
  TJ: 'Middle East', AF: 'Middle East', PK: 'Middle East',
  // Africa
  ZA: 'Africa', EG: 'Africa', KE: 'Africa', NG: 'Africa',
  MA: 'Africa', ET: 'Africa', DZ: 'Africa', TN: 'Africa',
  LY: 'Africa', SD: 'Africa', GH: 'Africa', CI: 'Africa',
  SN: 'Africa', ML: 'Africa', BF: 'Africa', NE: 'Africa',
  TD: 'Africa', TG: 'Africa', BJ: 'Africa', CD: 'Africa',
  CM: 'Africa', GA: 'Africa', CG: 'Africa', TZ: 'Africa',
  UG: 'Africa', RW: 'Africa', ZW: 'Africa', MW: 'Africa',
  MZ: 'Africa', NA: 'Africa', BW: 'Africa', MG: 'Africa',
  MU: 'Africa', ZM: 'Africa',
  // Asia (South, Southeast, East)
  SG: 'Asia', HK: 'Asia', MY: 'Asia', TH: 'Asia',
  ID: 'Asia', PH: 'Asia', IN: 'Asia', LK: 'Asia',
  BD: 'Asia', MM: 'Asia', VN: 'Asia', NP: 'Asia',
  JP: 'Asia', KR: 'Asia', CN: 'Asia', TW: 'Asia',
  KH: 'Asia', LA: 'Asia', BN: 'Asia', MO: 'Asia',
  // Oceania
  AU: 'Oceania', NZ: 'Oceania', PF: 'Oceania', NC: 'Oceania',
  FJ: 'Oceania', PG: 'Oceania', SB: 'Oceania', VU: 'Oceania',
  GU: 'Oceania', CK: 'Oceania', WS: 'Oceania', TO: 'Oceania', KI: 'Oceania',
  // Additional Europe
  JE: 'Europe', CY: 'Europe', LU: 'Europe', MT: 'Europe',
  ME: 'Europe', BA: 'Europe', XK: 'Europe', MD: 'Europe', IM: 'Europe',
  // Additional North America (Caribbean / Central America)
  BZ: 'North America', AG: 'North America', GD: 'North America', KN: 'North America',
  // Additional Africa
  ER: 'Africa', CF: 'Africa', GM: 'Africa', SO: 'Africa', DJ: 'Africa',
  AO: 'Africa', MR: 'Africa', GW: 'Africa', RE: 'Africa', SC: 'Africa',
  CV: 'Africa', ST: 'Africa',
  // Additional Middle East
  YE: 'Middle East',
};

export const REGIONS = [
  'North America', 'South America', 'Europe', 'Middle East', 'Africa', 'Asia', 'Oceania',
];

export function getRegion(country) {
  return COUNTRY_REGION[country] ?? 'Other';
}

export const COUNTRY_NAMES = {
  AE: 'United Arab Emirates', AF: 'Afghanistan', AL: 'Albania',
  AO: 'Angola',               AR: 'Argentina',   AT: 'Austria',
  AU: 'Australia',            AZ: 'Azerbaijan',  BA: 'Bosnia & Herzegovina',
  BB: 'Barbados',             BD: 'Bangladesh',  BE: 'Belgium',
  BG: 'Bulgaria',             BH: 'Bahrain',     BO: 'Bolivia',
  BR: 'Brazil',               BS: 'Bahamas',     BZ: 'Belize',
  CA: 'Canada',               CH: 'Switzerland', CI: "Côte d'Ivoire",
  CL: 'Chile',                CM: 'Cameroon',    CN: 'China',
  CO: 'Colombia',             CR: 'Costa Rica',  CU: 'Cuba',
  CY: 'Cyprus',               CZ: 'Czech Republic', DE: 'Germany',
  DK: 'Denmark',              DO: 'Dominican Republic', DZ: 'Algeria',
  EC: 'Ecuador',              EE: 'Estonia',     EG: 'Egypt',
  ES: 'Spain',                ET: 'Ethiopia',    FI: 'Finland',
  FJ: 'Fiji',                 FR: 'France',      GB: 'United Kingdom',
  GH: 'Ghana',                GR: 'Greece',      GT: 'Guatemala',
  GY: 'Guyana',               HK: 'Hong Kong',   HN: 'Honduras',
  HR: 'Croatia',              HU: 'Hungary',     ID: 'Indonesia',
  IE: 'Ireland',              IL: 'Israel',      IN: 'India',
  IQ: 'Iraq',                 IR: 'Iran',        IS: 'Iceland',
  IT: 'Italy',                JM: 'Jamaica',     JO: 'Jordan',
  JP: 'Japan',                KE: 'Kenya',       KH: 'Cambodia',
  KR: 'South Korea',          KW: 'Kuwait',      KZ: 'Kazakhstan',
  LA: 'Laos',                 LB: 'Lebanon',     LK: 'Sri Lanka',
  LT: 'Lithuania',            LU: 'Luxembourg',  LV: 'Latvia',
  LY: 'Libya',                MA: 'Morocco',     ME: 'Montenegro',
  MG: 'Madagascar',           MK: 'North Macedonia', MM: 'Myanmar',
  MN: 'Mongolia',             MO: 'Macau',       MT: 'Malta',
  MU: 'Mauritius',            MX: 'Mexico',      MY: 'Malaysia',
  MZ: 'Mozambique',           NG: 'Nigeria',     NI: 'Nicaragua',
  NL: 'Netherlands',          NO: 'Norway',      NP: 'Nepal',
  NZ: 'New Zealand',          OM: 'Oman',        PA: 'Panama',
  PE: 'Peru',                 PG: 'Papua New Guinea', PH: 'Philippines',
  PK: 'Pakistan',             PL: 'Poland',      PR: 'Puerto Rico',
  PT: 'Portugal',             PY: 'Paraguay',    QA: 'Qatar',
  RO: 'Romania',              RS: 'Serbia',      RU: 'Russia',
  RW: 'Rwanda',               SA: 'Saudi Arabia', SD: 'Sudan',
  SE: 'Sweden',               SG: 'Singapore',   SI: 'Slovenia',
  SK: 'Slovakia',             SN: 'Senegal',     SR: 'Suriname',
  SV: 'El Salvador',          TH: 'Thailand',    TN: 'Tunisia',
  TR: 'Turkey',               TT: 'Trinidad & Tobago', TW: 'Taiwan',
  TZ: 'Tanzania',             UA: 'Ukraine',     UG: 'Uganda',
  US: 'United States',        UY: 'Uruguay',     UZ: 'Uzbekistan',
  VE: 'Venezuela',            VN: 'Vietnam',     XK: 'Kosovo',
  YE: 'Yemen',                ZA: 'South Africa', ZM: 'Zambia',
  ZW: 'Zimbabwe',
  // ── Coverage fill (pre-existing gaps + 1500 expansion) ───────────────────────
  SX: 'Sint Maarten',         KY: 'Cayman Islands',   BM: 'Bermuda',
  CW: 'Curaçao',              BY: 'Belarus',          GE: 'Georgia',
  AM: 'Armenia',              KG: 'Kyrgyzstan',       TM: 'Turkmenistan',
  TJ: 'Tajikistan',           ML: 'Mali',             BF: 'Burkina Faso',
  NE: 'Niger',                TD: 'Chad',             TG: 'Togo',
  BJ: 'Benin',                CD: 'DR Congo',         GA: 'Gabon',
  CG: 'Congo',                MW: 'Malawi',           NA: 'Namibia',
  BW: 'Botswana',             BN: 'Brunei',           PF: 'French Polynesia',
  NC: 'New Caledonia',        SB: 'Solomon Islands',  VU: 'Vanuatu',
  GU: 'Guam',                 CK: 'Cook Islands',     JE: 'Jersey',
  MD: 'Moldova',              ER: 'Eritrea',          CF: 'Central African Republic',
  GM: 'Gambia',               SO: 'Somalia',          DJ: 'Djibouti',
  MR: 'Mauritania',           GW: 'Guinea-Bissau',    RE: 'Réunion',
  SC: 'Seychelles',           CV: 'Cape Verde',       ST: 'São Tomé & Príncipe',
  WS: 'Samoa',                TO: 'Tonga',            KI: 'Kiribati',
  AG: 'Antigua & Barbuda',    GD: 'Grenada',          KN: 'St Kitts & Nevis',
  IM: 'Isle of Man',          AW: 'Aruba',            TL: 'Timor-Leste',
  BT: 'Bhutan',               FO: 'Faroe Islands',    GL: 'Greenland',
  AS: 'American Samoa',       NR: 'Nauru',            PM: 'St Pierre & Miquelon',
  SH: 'St Helena',            BQ: 'Caribbean Netherlands', BL: 'St Barthélemy',
  GI: 'Gibraltar',            NF: 'Norfolk Island',   AI: 'Anguilla',
  BI: 'Burundi',              KM: 'Comoros',          DM: 'Dominica',
  GQ: 'Equatorial Guinea',    SZ: 'Eswatini',         GN: 'Guinea',
  HT: 'Haiti',                KP: 'North Korea',      LS: 'Lesotho',
  LR: 'Liberia',              MV: 'Maldives',         MH: 'Marshall Islands',
  FM: 'Micronesia',           PW: 'Palau',            LC: 'St Lucia',
  VC: 'St Vincent & Grenadines', SL: 'Sierra Leone',  SS: 'South Sudan',
  SY: 'Syria',                TV: 'Tuvalu',
};

export function getCountryName(code) {
  return COUNTRY_NAMES[code] ?? code;
}

/**
 * Return {businessScore, leisureScore} for an airport.
 * Looks up AIRPORT_SCORES first; falls back to tier-based defaults.
 *
 * @param {string} code  IATA airport code
 * @returns {{ businessScore: number, leisureScore: number }}
 */
export function getAirportScores(code) {
  if (AIRPORT_SCORES[code]) return AIRPORT_SCORES[code];

  const ap = getAirport(code);
  // Tier-based fallbacks: mega hubs are more business-oriented than tiny regionals
  const defaults = {
    mega:     { businessScore: 65, leisureScore: 55 },
    major:    { businessScore: 50, leisureScore: 52 },
    regional: { businessScore: 32, leisureScore: 55 },
  };
  return defaults[ap?.tier] ?? { businessScore: 40, leisureScore: 55 };
}

// ─── Per-airport cargo scores ──────────────────────────────────────────────────
//
// cargoScore (0–100): how freight-heavy an airport is, INDEPENDENT of passenger
// traffic. High = major air-cargo gateway (manufacturing exports, integrator
// superhubs, perishables gateways, belly-freight mega-hubs). 100 ≈ the world's #1
// freight airport (HKG). Pure leisure airports score very low — sunbathers don't
// generate air freight.
//
// This is deliberately NOT the same as businessScore: some places are freight
// powerhouses with modest passenger business demand (MEM/FedEx, SDF/UPS, ANC as a
// transpacific fuel-and-freight pivot, LEJ/DHL), while some heavy business-travel
// airports (LCY, DCA) ship almost no cargo.
//
// Unlisted airports fall back to getAirportCargoScore(), which derives a value from
// businessScore (trade activity is the best cheap proxy when we have no real data).

export const CARGO_SCORES = {
  // ── Global freight mega-hubs ────────────────────────────────────────────────
  HKG: 100,  // Hong Kong – perennial #1 air-cargo airport
  MEM:  98,  // Memphis – FedEx superhub
  PVG:  96,  // Shanghai Pudong – China's export gateway
  ANC:  95,  // Anchorage – transpacific freight pivot (tiny pax, huge cargo)
  ICN:  92,  // Incheon – Samsung/LG electronics exports
  SDF:  90,  // Louisville – UPS Worldport
  DXB:  88,  // Dubai – Emirates SkyCargo
  TPE:  88,  // Taipei – semiconductor exports
  NRT:  86,  // Tokyo Narita
  FRA:  85,  // Frankfurt – Lufthansa Cargo, industrial Europe
  CVG:  85,  // Cincinnati – DHL Americas hub + Amazon Air
  LAX:  85,  // Los Angeles – Pacific gateway
  SIN:  84,  // Singapore Changi
  CAN:  82,  // Guangzhou – Pearl River Delta manufacturing
  MIA:  80,  // Miami – Latin America perishables gateway
  AMS:  80,  // Amsterdam Schiphol
  LEJ:  80,  // Leipzig/Halle – DHL/AeroLogic European hub
  DOH:  80,  // Doha – Qatar Airways Cargo

  // ── Strong cargo airports ───────────────────────────────────────────────────
  ORD:  78,  // Chicago
  CDG:  78,  // Paris Charles de Gaulle
  IST:  78,  // Istanbul – Turkish Cargo
  LUX:  78,  // Luxembourg – Cargolux
  PEK:  78,  // Beijing Capital
  HND:  72,  // Tokyo Haneda
  LHR:  72,  // Heathrow (belly freight)
  SZX:  72,  // Shenzhen – electronics
  JFK:  74,  // New York
  KIX:  68,  // Osaka Kansai
  BOM:  68,  // Mumbai
  DEL:  66,  // Delhi
  ATL:  64,  // Atlanta
  DFW:  64,  // Dallas/Fort Worth
  BKK:  64,  // Bangkok
  KUL:  62,  // Kuala Lumpur
  CGK:  58,  // Jakarta
  YYZ:  62,  // Toronto
  GRU:  62,  // São Paulo
  BOG:  62,  // Bogotá – cut-flower exports
  NBO:  62,  // Nairobi – flowers/perishables
  ADD:  62,  // Addis Ababa – Ethiopian Cargo
  MAA:  60,  // Chennai
  BLR:  60,  // Bengaluru
  EMA:  62,  // East Midlands – UK express hub
  LGG:  68,  // Liège – cargo-focused
  HHN:  55,  // Frankfurt Hahn – cargo
  SEA:  60,  // Seattle
  SFO:  60,  // San Francisco
  UIO:  58,  // Quito – flower exports
  SCL:  56,  // Santiago – cherries/salmon
  LIM:  54,  // Lima – asparagus/perishables
  JNB:  58,  // Johannesburg
  HYD:  56,  // Hyderabad – pharma
  MNL:  54,  // Manila
  SGN:  56,  // Ho Chi Minh City
  HAN:  56,  // Hanoi
  SYD:  56,  // Sydney
  MEL:  50,  // Melbourne
  AKL:  48,  // Auckland – perishables
  EZE:  50,  // Buenos Aires
};

/**
 * Cargo score (0–100) for an airport.
 * Listed airports use their explicit value; everything else derives a value from
 * businessScore — trade/industrial activity is the best cheap proxy for freight
 * when we have no calibrated cargo figure. Pure-leisure airports (low businessScore)
 * therefore generate very little cargo, as intended.
 *
 * @param {string} code
 * @returns {number} 0–100
 */
export function getAirportCargoScore(code) {
  if (CARGO_SCORES[code] != null) return CARGO_SCORES[code];
  const { businessScore } = getAirportScores(code);
  // Derived fallback: scale business activity down slightly (most business airports
  // ship less than the dedicated freight hubs) and floor it so nowhere is truly zero.
  return Math.max(8, Math.round(businessScore * 0.7));
}
