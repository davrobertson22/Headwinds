#!/usr/bin/env node
/**
 * add-photos.mjs — fill the image: '' field for the newly-added aircraft with
 * verified Wikimedia Commons URLs (sourced via the live MediaWiki pageimages API).
 * Replaces only the empty image of the matching id; leaves existing photos alone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const aircraftPath = path.resolve(__dir, '../../src/data/aircraft.js');

const IMG = {
  dc3:'https://upload.wikimedia.org/wikipedia/commons/d/df/Douglas_DC-3%2C_SE-CFP.jpg',
  dc863:'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f3/DC-8_Airborne_Laboratory_in_flight_over_snow-capped_Sierra_Nevada_mountain_range.jpg/1280px-DC-8_Airborne_Laboratory_in_flight_over_snow-capped_Sierra_Nevada_mountain_range.jpg',
  dc873f:'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f3/DC-8_Airborne_Laboratory_in_flight_over_snow-capped_Sierra_Nevada_mountain_range.jpg/1280px-DC-8_Airborne_Laboratory_in_flight_over_snow-capped_Sierra_Nevada_mountain_range.jpg',
  caravelle:'https://upload.wikimedia.org/wikipedia/commons/8/8b/Sud_SE-210_Caravelle_III%2C_F-BHRS%2C_Air_France_Manteufel-1.jpg',
  trident3b:'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6d/British_Airways_Trident3B_%287107744185%29.jpg/1280px-British_Airways_Trident3B_%287107744185%29.jpg',
  vc10:'https://upload.wikimedia.org/wikipedia/commons/thumb/b/bc/RAF_Vickers_VC10_K3_over_the_North_Sea_Lofting.jpg/1280px-RAF_Vickers_VC10_K3_over_the_North_Sea_Lofting.jpg',
  cv990:'https://upload.wikimedia.org/wikipedia/commons/thumb/2/28/Swissair_Convair_990_in_flight.jpg/1280px-Swissair_Convair_990_in_flight.jpg',
  tu154m:'https://upload.wikimedia.org/wikipedia/commons/4/4c/Tupolev_Tu-154M%2C_Iran_Air_Tours_JP6511800.jpg',
  tu134:'https://upload.wikimedia.org/wikipedia/commons/c/c2/Tretyakovo_Tupolev_Tu-134.jpg',
  il62m:'https://upload.wikimedia.org/wikipedia/commons/4/4a/Air-to-air_with_a_Russian_Air_Force_Ilyushin_Il-62M_%28retouched%29.jpg',
  il86:'https://upload.wikimedia.org/wikipedia/commons/a/a0/Aeroflot_RA_Ilyushin_Il-86_von_Wedelstaedt.jpg',
  yak42:'https://upload.wikimedia.org/wikipedia/commons/2/24/International_Jet_Tour_Yakovlev_Yak-42D_Nikiforov.jpg',
  yak40:'https://upload.wikimedia.org/wikipedia/commons/5/5a/Yakovlev_Yak-40%2C_Centr_Ug_JP7586206.jpg',
  f27:'https://upload.wikimedia.org/wikipedia/commons/3/37/Fokker_F27_Friendship_US_Army_Golden_Knight.jpg',
  f28:'https://upload.wikimedia.org/wikipedia/commons/6/64/Piedmont_F-28-1000.jpg',
  b720b:'https://upload.wikimedia.org/wikipedia/commons/a/aa/Cyprus_Airways_Boeing_720B_G-BCBB_LHR_1978-8-24.png',
  b747100:'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b8/B-747_Iberia.jpg/1280px-B-747_Iberia.jpg',
  b747300:'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b8/B-747_Iberia.jpg/1280px-B-747_Iberia.jpg',
  a300b4:'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1c/Iran_Air_Airbus_A300-605R%3B_EP-IBD%40FRA%3B06.07.2011_603ks_%285915220574%29.jpg/1280px-Iran_Air_Airbus_A300-605R%3B_EP-IBD%40FRA%3B06.07.2011_603ks_%285915220574%29.jpg',
  a300600f:'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1c/Iran_Air_Airbus_A300-605R%3B_EP-IBD%40FRA%3B06.07.2011_603ks_%285915220574%29.jpg/1280px-Iran_Air_Airbus_A300-605R%3B_EP-IBD%40FRA%3B06.07.2011_603ks_%285915220574%29.jpg',
  a310200:'https://upload.wikimedia.org/wikipedia/commons/5/5d/Air_Transat_A310_%28C-GTSF%29_%40_LHR%2C_Aug_2009.jpg',
  l188:'https://upload.wikimedia.org/wikipedia/commons/1/15/Varig_Lockheed_L-188A_Electra_Groves-1.jpg',
  bac111:'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1f/TAROM_BAC_1-11-500%3B_YR-BCI%40ZRH%3B02.10.1995_%288353902456%29.jpg/1280px-TAROM_BAC_1-11-500%3B_YR-BCI%40ZRH%3B02.10.1995_%288353902456%29.jpg',
  cv580:'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5e/SAS_Convair_CV-440_Metropolitan%2C_Ivar_Viking_LN-KLB_in_the_air%2C_in_flight.jpg/1280px-SAS_Convair_CV-440_Metropolitan%2C_Ivar_Viking_LN-KLB_in_the_air%2C_in_flight.jpg',
  b737max8200:'https://upload.wikimedia.org/wikipedia/commons/thumb/3/32/Alaska_737_Max_9.jpg/1280px-Alaska_737_Max_9.jpg',
  a330800:'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c0/Airbus_A330neo_F-WTTN_37.jpg/1280px-Airbus_A330neo_F-WTTN_37.jpg',
  sj100new:'https://upload.wikimedia.org/wikipedia/commons/b/bd/Sukhoi_Superjet_100_%285096752902%29_%28cropped%29.jpg',
  mc21310:'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5d/MC-21-300_maiden_flight_in_Irkutsk_%282%29.jpg/1280px-MC-21-300_maiden_flight_in_Irkutsk_%282%29.jpg',
  c929:'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b8/C929_model_at_2026_Singapore_Airshow_1.jpg/1280px-C929_model_at_2026_Singapore_Airshow_1.jpg',
  do328:'https://upload.wikimedia.org/wikipedia/commons/4/46/Sun-Air_Do-328.jpg',
  do328jet:'https://upload.wikimedia.org/wikipedia/commons/4/46/Sun-Air_Do-328.jpg',
  do228:'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0b/Do228NG_-_RIAT_2012_%2818649688613%29.jpg/1280px-Do228NG_-_RIAT_2012_%2818649688613%29.jpg',
  emb120:'https://upload.wikimedia.org/wikipedia/commons/thumb/2/29/N569SW_LAX_%2826322494726%29.jpg/1280px-N569SW_LAX_%2826322494726%29.jpg',
  js31:'https://upload.wikimedia.org/wikipedia/commons/thumb/7/7a/British_Aerospace_Jetstream_3102_%E2%80%98G-NFLA.jpg/1280px-British_Aerospace_Jetstream_3102_%E2%80%98G-NFLA.jpg',
  js41:'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8e/Easternairways_j41_g-majx_arp.jpg/1280px-Easternairways_j41_g-majx_arp.jpg',
  saab340a:'https://upload.wikimedia.org/wikipedia/commons/thumb/0/08/Saab_340_G-LGNC_IMG_3425_%2811712072893%29.jpg/1280px-Saab_340_G-LGNC_IMG_3425_%2811712072893%29.jpg',
  dhc8100:'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ec/Hamburg_Airport_Wider%C3%B8e_Bombardier_DHC-8-402Q_LN-WDR_%28DSC08713%29.jpg/1280px-Hamburg_Airport_Wider%C3%B8e_Bombardier_DHC-8-402Q_LN-WDR_%28DSC08713%29.jpg',
  dhc8200:'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ec/Hamburg_Airport_Wider%C3%B8e_Bombardier_DHC-8-402Q_LN-WDR_%28DSC08713%29.jpg/1280px-Hamburg_Airport_Wider%C3%B8e_Bombardier_DHC-8-402Q_LN-WDR_%28DSC08713%29.jpg',
  dash7:'https://upload.wikimedia.org/wikipedia/commons/1/1f/De_Havilland_Canada_DHC-7-110_Dash_7%2C_Brymon_Airways_AN2141415.jpg',
  ma60:'https://upload.wikimedia.org/wikipedia/commons/thumb/0/05/B-3706_-_Okay_Airways_-_Modern_Ark_60_-_DLC_%289575868910%29.jpg/1280px-B-3706_-_Okay_Airways_-_Modern_Ark_60_-_DLC_%289575868910%29.jpg',
  ma600:'https://upload.wikimedia.org/wikipedia/commons/thumb/0/05/B-3706_-_Okay_Airways_-_Modern_Ark_60_-_DLC_%289575868910%29.jpg/1280px-B-3706_-_Okay_Airways_-_Modern_Ark_60_-_DLC_%289575868910%29.jpg',
  c408:'https://upload.wikimedia.org/wikipedia/commons/thumb/8/83/2021-07-27_CessnaSkyCourier.jpg/1280px-2021-07-27_CessnaSkyCourier.jpg',
  an24:'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b0/Volga-Avia_Antonov_An-24.jpg/1280px-Volga-Avia_Antonov_An-24.jpg',
  emb110:'https://upload.wikimedia.org/wikipedia/commons/e/ee/Embraer_EMB_110_%28Forca_Aerea_Brasileira%29_%C3%81gata_7_%288780126305%29.jpg',
  a350f:'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f7/EGLF_-_Airbus_A350-941_-_F-WZNW.jpg/1280px-EGLF_-_Airbus_A350-941_-_F-WZNW.jpg',
  b7778f:'https://upload.wikimedia.org/wikipedia/commons/thumb/3/37/777X_Roll-Out_%2840407373023%29_%28cropped%29.jpg/1280px-777X_Roll-Out_%2840407373023%29_%28cropped%29.jpg',
  b757200pf:'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ed/Delta_757-200_N713TW_on_final_approach_to_Boston_Dec_2024_2.jpg/1280px-Delta_757-200_N713TW_on_final_approach_to_Boston_Dec_2024_2.jpg',
  md11f:'https://upload.wikimedia.org/wikipedia/commons/thumb/0/00/McDonnell_Douglas_MD-11P_KLM_PH-KCC.jpg/1280px-McDonnell_Douglas_MD-11P_KLM_PH-KCC.jpg',
  dc1030f:'https://upload.wikimedia.org/wikipedia/commons/d/d9/Continental_Airlines_DC-10.jpg',
  b737400f:'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5b/Classic_Colors_Southwest_Airlines_N648SW_Boeing_737-3H4_SJC.jpg/1280px-Classic_Colors_Southwest_Airlines_N648SW_Boeing_737-3H4_SJC.jpg',
  b737300f:'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5b/Classic_Colors_Southwest_Airlines_N648SW_Boeing_737-3H4_SJC.jpg/1280px-Classic_Colors_Southwest_Airlines_N648SW_Boeing_737-3H4_SJC.jpg',
  b727200f:'https://upload.wikimedia.org/wikipedia/commons/thumb/5/57/B-727_Iberia_%28cropped%29.jpg/1280px-B-727_Iberia_%28cropped%29.jpg',
  e190f:'https://upload.wikimedia.org/wikipedia/commons/3/3d/KLM_Cityhopper_-_Embraer_190LR_-_AN2571563.jpg',
  a321p2f:'https://upload.wikimedia.org/wikipedia/commons/thumb/8/81/Airbus_A321-231%28w%29_%E2%80%98N915US%E2%80%99_American_Airlines_%2828442733186%29.jpg/1280px-Airbus_A321-231%28w%29_%E2%80%98N915US%E2%80%99_American_Airlines_%2828442733186%29.jpg',
  b767200sf:'https://upload.wikimedia.org/wikipedia/commons/thumb/4/43/Delta_Air_Lines_B767-332_N130DL.jpg/1280px-Delta_Air_Lines_B767-332_N130DL.jpg',
  an12:'https://upload.wikimedia.org/wikipedia/commons/b/b5/Antonov_An-12BK%2C_Russia_-_Air_Force_AN1879625.jpg',
};

let src = fs.readFileSync(aircraftPath, 'utf8');
let done = 0, missing = [];
for (const [id, url] of Object.entries(IMG)) {
  // Replace the empty image field within the object that has this id.
  const re = new RegExp(`(id: '${id}',[\\s\\S]*?image: )''`);
  if (re.test(src)) { src = src.replace(re, `$1'${url}'`); done++; }
  else missing.push(id);
}
fs.writeFileSync(aircraftPath, src);
console.log(`Set ${done} photos. ${missing.length ? 'Not matched: '+missing.join(',') : 'all matched.'}`);
