// Topic lists for tools/grow-library.js. Add topics freely: the script skips the ones already written.
const PLACE_GUIDE = "For a country or city: its flag exactly (colours, layout, emblem), the real look (skyline and landmarks, architecture, streets, nature, light and climate), how people dress, and how people greet and address each other there (with the words in the local language).";

const countries = [
  "Afghanistan", "Albania", "Algeria", "Andorra", "Angola", "Antigua and Barbuda", "Argentina", "Armenia", "Australia", "Austria",
  "Azerbaijan", "Bahamas", "Bahrain", "Bangladesh", "Barbados", "Belarus", "Belgium", "Belize", "Benin", "Bhutan", "Bolivia",
  "Bosnia and Herzegovina", "Botswana", "Brunei", "Bulgaria", "Burkina Faso", "Burundi", "Cambodia", "Cameroon", "Canada",
  "Cape Verde", "Central African Republic", "Chad", "Chile", "Colombia", "Comoros", "Congo (Brazzaville)", "DR Congo",
  "Costa Rica", "Ivory Coast", "Croatia", "Cuba", "Cyprus", "Czech Republic", "Denmark", "Djibouti", "Dominica",
  "Dominican Republic", "Ecuador", "El Salvador", "Equatorial Guinea", "Eritrea", "Estonia", "Eswatini", "Ethiopia", "Fiji",
  "Finland", "Gabon", "Gambia", "Georgia", "Ghana", "Greece", "Grenada", "Guatemala", "Guinea", "Guinea-Bissau", "Guyana",
  "Haiti", "Honduras", "Hungary", "Iceland", "Indonesia", "Ireland", "Jamaica", "Kazakhstan", "Kenya", "Kiribati",
  "Kyrgyzstan", "Laos", "Latvia", "Lesotho", "Liberia", "Libya", "Liechtenstein", "Lithuania", "Luxembourg", "Madagascar",
  "Malawi", "Malaysia", "Maldives", "Mali", "Malta", "Marshall Islands", "Mauritania", "Mauritius", "Mexico", "Micronesia",
  "Moldova", "Monaco", "Mongolia", "Montenegro", "Mozambique", "Myanmar", "Namibia", "Nauru", "Nepal", "Netherlands",
  "New Zealand", "Nicaragua", "Niger", "Nigeria", "North Korea", "North Macedonia", "Norway", "Oman", "Pakistan", "Palau",
  "Palestine", "Panama", "Papua New Guinea", "Paraguay", "Peru", "Philippines", "Poland", "Portugal", "Romania", "Rwanda",
  "Saint Kitts and Nevis", "Saint Lucia", "Saint Vincent and the Grenadines", "Samoa", "San Marino", "Sao Tome and Principe",
  "Senegal", "Serbia", "Seychelles", "Sierra Leone", "Singapore", "Slovakia", "Slovenia", "Solomon Islands", "Somalia",
  "South Africa", "South Korea", "South Sudan", "Sri Lanka", "Sudan", "Suriname", "Sweden", "Switzerland", "Taiwan",
  "Tajikistan", "Tanzania", "Thailand", "Timor-Leste", "Togo", "Tonga", "Trinidad and Tobago", "Tunisia", "Turkmenistan",
  "Tuvalu", "Uganda", "Ukraine", "Uruguay", "Uzbekistan", "Vanuatu", "Vatican City", "Venezuela", "Vietnam", "Yemen",
  "Zambia", "Zimbabwe",
];

const iraq = [
  "Mosul", "Mosul old city and the al-Nuri mosque", "Kirkuk and its citadel", "Duhok", "Zakho and the Delal bridge", "Amadiya",
  "Halabja", "Ranya and Lake Dukan", "Soran and the Hamilton road", "Rawanduz canyon", "Akre", "Shaqlawa", "Penjwen",
  "Tikrit", "Samarra and the spiral minaret", "Baqubah", "Kut", "Amarah", "Nasiriyah", "Ur and the ziggurat", "Samawah",
  "Diwaniyah", "Hillah", "Babylon ruins", "Kufa", "Ramadi", "Fallujah", "Haditha", "Anah on the Euphrates", "Hit and its waterwheels",
  "Rutba desert road", "Al-Qurna where the Tigris and Euphrates meet", "Faw peninsula", "Umm Qasr port", "Zubair", "Abu al-Khasib palm groves",
  "Chibayish marshes", "Baghdad Mansour district", "Baghdad Adhamiya", "Baghdad Kadhimiya", "Baghdad Zayouna", "Baghdad Jadriya",
  "Baghdad Arasat street", "Baghdad Palestine street", "Baghdad Sadr City", "Baghdad Bab al-Sharqi", "Baghdad Shorja market",
  "Baghdad Tahrir square and the Freedom monument", "Baghdad Zawraa park", "Baghdad Abu Nuwas street", "Baghdad Al-Shaheed monument",
  "Baghdad Hands of Victory arches", "Baghdad Iraqi Museum", "Baghdad University", "Baghdad International Airport",
  "Erbil Sami Abdulrahman park", "Erbil Family Mall", "Sulaymaniyah Goizha mountain", "Sulaymaniyah bazaar",
  "Basra Corniche and Shatt al-Arab", "Basra Ashar old district", "Basra Sindbad island", "Karbala old city",
  "Najaf old city and the Wadi al-Salam cemetery", "Iraqi village by the river", "Iraqi desert road with checkpoint", "Iraqi university campus",
  "Iraqi traditional cafe (gahwa)", "Iraqi family house interior", "Iraqi wedding hall", "Iraqi mall interior", "Iraqi hospital ward",
  "Iraqi government office", "Iraqi school classroom", "Iraqi football stadium (Basra International)",
];

const landmarks = [
  "Burj Khalifa", "Eiffel Tower", "Statue of Liberty", "Big Ben", "Colosseum", "Great Wall of China", "Taj Mahal", "Petra Treasury",
  "Giza pyramids and Sphinx", "Sydney Opera House", "Christ the Redeemer", "Machu Picchu", "Hagia Sophia", "Blue Mosque Istanbul",
  "Kaaba and the Grand Mosque in Makkah", "Prophet's Mosque in Madinah", "Al-Aqsa and the Dome of the Rock", "Sheikh Zayed Grand Mosque",
  "Burj Al Arab", "Kuwait Towers", "Museum of the Future Dubai", "Louvre pyramid", "Sagrada Familia", "Alhambra", "Acropolis",
  "Leaning Tower of Pisa", "Venice Grand Canal", "Times Square", "Golden Gate Bridge", "Grand Canyon", "Niagara Falls", "Mount Fuji",
  "Shibuya crossing", "Forbidden City", "Angkor Wat", "Marina Bay Sands", "Petronas Towers", "Santorini", "Cappadocia balloons",
  "Northern lights in Iceland", "Swiss Alps village", "Maldives water villas", "Bali rice terraces", "Dead Sea", "Wadi Rum",
  "Sahara dunes in Morocco", "Victoria Falls", "Kilimanjaro", "Amazon rainforest", "Antarctica ice", "Hollywood sign",
  "Brandenburg Gate", "Red Square and St Basil's", "Tower Bridge London", "Stonehenge", "Neuschwanstein castle", "Amsterdam canals",
  "Prague old town", "Dubrovnik walls", "Ha Long Bay", "Pamukkale terraces", "Mecca clock tower", "Jeddah corniche", "Doha skyline",
  "Muscat Sultan Qaboos mosque", "Bahrain World Trade Center", "Beirut Raouche rocks", "Damascus Umayyad Mosque", "Cairo Khan el-Khalili",
  "Luxor Karnak temple", "Marrakech Jemaa el-Fnaa", "Chefchaouen blue city", "Tunis Sidi Bou Said", "Istanbul Grand Bazaar",
];

const items = [
  "Toyota Camry", "Toyota Corolla", "Toyota Prado", "Toyota Fortuner", "Nissan Patrol", "Nissan Sunny", "Kia Sportage", "Kia Cerato",
  "Hyundai Elantra", "Hyundai Sonata", "Hyundai Tucson", "Chevrolet Tahoe", "GMC Yukon", "Chevrolet Caprice (Iraqi classic)",
  "Mercedes G-Class", "Mercedes S-Class", "BMW X5", "Range Rover", "Tesla Model 3", "Ford Mustang", "Jeep Wrangler",
  "Dodge Charger", "Mitsubishi Pajero", "Honda Accord", "Audi A6", "Volkswagen Passat", "Peugeot 206", "Chery Tiggo", "BYD electric car",
  "Iraqi Airways Boeing 737", "Emirates A380", "private jet", "fighter jet at an air show", "cargo container ship", "fishing dhow",
  "speed boat", "jet ski", "sports motorcycle", "electric scooter", "school bus", "ambulance", "fire engine", "police car",
  "garbage truck", "crane on a construction site", "excavator", "cement mixer truck", "fuel tanker", "camper van",
  "iPhone 17 Pro", "Samsung Galaxy S", "iPad tablet", "MacBook", "gaming PC with RGB lights", "PlayStation 5", "smart watch",
  "wireless earbuds", "DSLR camera", "drone (DJI)", "ring light and phone tripod", "microphone for podcasts", "smart TV in a living room",
  "air conditioner split unit", "water cooler (Iraqi desert cooler)", "electric generator (Iraqi neighbourhood generator)",
  "solar panels on a roof", "washing machine", "refrigerator", "microwave oven", "gas stove with oven", "blender", "air fryer",
  "electric kettle", "Turkish coffee pot (dallah/cezve)", "Arabic coffee dallah and finjan", "hookah (argileh)", "prayer beads (masbaha)",
  "oud instrument", "darbuka drum", "qanun instrument", "violin", "piano", "electric guitar", "DJ console",
  "football", "basketball and hoop", "tennis racket", "treadmill", "dumbbells", "bicycle helmet", "fishing rod",
  "makeup brush set", "hair dryer", "straightener", "nail polish", "oud perfume (dehn al oud)", "bakhoor incense burner",
  "luxury handbag", "sunglasses", "sneakers", "high heels", "leather shoes", "backpack", "suitcase on wheels", "umbrella",
  "gold necklace (Iraqi bridal gold)", "diamond ring", "silver ring with agate (aqeeq)", "pocket watch",
  "medicine bottles and pills", "wheelchair", "hospital bed", "dental chair", "X-ray machine", "MRI scanner",
  "shopping cart in a supermarket", "cash register", "card payment terminal", "ATM machine", "shop shelves with products",
  "cardboard boxes and parcels", "delivery bag", "office chair and desk", "whiteboard", "projector", "printer",
  "baby stroller", "baby crib", "children's toys", "teddy bear", "balloons", "wedding cake", "birthday cake", "chocolate box",
  "Iraqi tea set on a tray", "watermelon", "pomegranate", "oranges", "bananas", "grapes", "tomatoes and cucumbers", "Iraqi pickles (torshi)",
  "amba mango pickle", "geymar with date syrup (Iraqi breakfast)", "lentil soup", "biryani Iraqi style", "tepsi baytinjan", "fasolia with rice",
  "Iraqi fried eggs and tomato (makhlama)", "shawarma spit", "falafel sandwich", "ice cream", "fresh juice shop (asir)", "Pepsi bottle",
  "water bottle", "coffee cup to go", "cappuccino with latte art", "Arabic sweets tray", "Kunafa", "Basbousa",
];

const actions = [
  "Iraqi wedding entrance (zaffa)", "henna night", "Newroz celebration", "Arbaeen walk (respectful, pilgrims walking)", "Eid prayer",
  "family picnic by the river", "kids playing football in an alley", "teenagers playing PlayStation", "father teaching son to ride a bike",
  "mother cooking dolma with daughters", "grandmother telling a story", "man reading a newspaper in a cafe", "playing dominoes in a cafe",
  "playing backgammon (tawla)", "smoking argileh in a cafe", "shopping for gold", "bargaining in a market", "buying vegetables",
  "car washing", "changing a tyre", "fixing a generator", "plastering a wall", "painting a house", "carpenter making furniture",
  "tailor sewing a dishdasha", "blacksmith hammering metal", "goldsmith at work", "pharmacist helping a customer",
  "doctor examining a child", "nurse taking blood pressure", "dentist with a patient", "teacher in a classroom",
  "university lecture", "student exam stress", "job interview", "business presentation", "signing a contract",
  "real estate agent showing a villa", "car showroom sale", "restaurant kitchen rush", "pizza tossing", "pouring Arabic coffee to guests",
  "making fresh juice", "ice cream scooping", "bakery morning rush", "delivery rider on a motorbike", "taxi driver chatting with a passenger",
  "traffic police directing cars", "firefighters spraying water", "farmer harvesting wheat", "date harvest climbing a palm",
  "shepherd with sheep", "fisherman casting a net in the marshes", "boat ride on the Tigris", "swimming in a pool", "diving into the sea",
  "surfing a wave", "skiing", "mountain hiking", "camping with a fire", "stargazing in the desert", "horse race", "camel race",
  "falconry", "football match goal celebration", "basketball dunk", "boxing training", "wrestling (zorkhaneh, traditional)",
  "yoga at sunrise", "running a marathon", "gym workout", "dancing at a party", "singing on stage", "playing the oud",
  "DJ at a party", "fireworks show", "graduation cap throw", "birthday surprise", "proposal with a ring", "baby's first steps",
  "kids blowing bubbles", "pillow fight", "snowball fight", "water balloon fight", "selfie with friends", "live streaming",
  "unboxing a new phone", "makeup tutorial", "hair salon styling", "barber fade haircut", "perfume shop testing", "fashion runway walk",
  "photo shoot in a studio", "filming a music video", "news anchor presenting", "sports commentator shouting", "reading the Quran (respectful)",
];

const human = [
  "embarrassment and blushing", "pride", "nervousness before a speech", "relief after good news", "jealousy (light, comic)",
  "boredom waiting", "disgust at bad food (comic)", "contempt", "gratitude", "admiration", "nostalgia", "determination",
  "excitement opening a gift", "shy first meeting", "awkward silence", "giggling fit", "sneezing", "coughing", "hiccups",
  "stretching after waking", "scratching the head", "rubbing tired eyes", "biting nails", "tapping fingers", "fixing hair in a mirror",
  "adjusting a headscarf", "adjusting a tie", "checking a watch", "wiping sweat", "clapping hands once with an idea", "facepalm",
  "thumbs up", "waving goodbye", "pointing at something", "shrugging shoulders", "rolling eyes (comic)", "winking", "raising one eyebrow",
  "pouting", "puffing cheeks", "whistling", "humming a tune", "singing along", "talking on the phone while walking",
  "elderly man with a cane", "pregnant woman", "athlete", "construction worker", "businesswoman", "influencer", "chef",
  "soldier in parade (ceremonial)", "police officer", "imam / sheikh (respectful)", "tribal sheikh in a mudhif", "Bedouin",
  "Kurdish grandmother", "Assyrian family", "Yazidi family (respectful)", "Turkmen family", "Marsh Arab (Maadan) family",
  "twins", "identical friends doing the same move", "people of different heights together", "person with glasses", "person with freckles",
  "person with curly hair", "bald man", "man with a big moustache", "woman with long braided hair", "teen with braces",
];

const sounds = [
  "keys jingling", "zipper", "paper tearing", "pen clicking", "camera shutter", "car alarm", "motorbike revving", "tuk-tuk engine",
  "generator starting", "electric fan", "air conditioner", "refrigerator hum", "kettle whistling", "frying oil", "boiling water",
  "chopping vegetables", "knife sharpening", "plates clattering", "glass clinking (cheers)", "ice cubes in a glass", "soda can opening",
  "chewing crunchy food", "slurping soup", "pouring tea", "door bell", "door knock", "door creak", "window shutter", "lock and key",
  "footsteps on stairs", "running on gravel", "high heels on marble", "children laughing in a playground", "baby crying", "baby giggling",
  "crowd murmur", "applause in a hall", "whistle in a stadium", "referee whistle", "school bell", "church bells (other countries)",
  "train passing", "airplane takeoff", "helicopter overhead", "ship horn", "seagulls at the port", "rooster at dawn", "donkey braying",
  "camel grunt", "horse neigh", "sheep bells", "frogs at night", "crickets", "owl hoot", "wind through palm fronds", "thunder", "heavy rain on a tin roof",
  "drizzle on a window", "river flowing", "fountain", "waves on a beach", "fire crackling", "fireworks", "balloon popping", "gift paper rustling",
  "typing on a keyboard", "mouse click", "phone vibration", "video call ringtone", "notification sounds", "printer", "elevator ding",
  "escalator hum", "shopping cart rattle", "cash register", "card payment beep", "car indicator", "car door closing", "car horn short beep",
  "tyre screech (no crash)", "ambulance siren", "street vendor calls", "call to prayer from far away", "oud melody", "darbuka rhythm",
];

const animals = [
  "lion", "tiger", "elephant", "giraffe", "zebra", "monkey", "gorilla", "bear", "wolf", "fox", "deer", "gazelle", "rabbit",
  "squirrel", "hedgehog", "turtle", "tortoise", "snake (calm, no attack)", "lizard", "crocodile", "frog", "parrot", "peacock",
  "eagle", "owl", "flamingo", "duck", "swan", "goose", "chicken and chicks", "rooster", "turkey", "ostrich", "camel calf",
  "donkey", "mule", "cow and calf", "goat kid", "lamb", "Persian cat", "street cat in Baghdad", "German shepherd", "golden retriever",
  "Saluki hunting dog", "hamster", "goldfish", "butterfly", "bee", "ant", "dragonfly", "dolphin", "whale", "shark (calm)", "octopus",
  "jellyfish", "penguin", "polar bear", "panda", "kangaroo", "koala", "horse foal", "Arabian falcon", "pigeon racing (Iraqi tradition)",
];

const nature = [
  "sunrise over the Tigris", "sunset over the desert", "full moon night", "starry desert sky", "rainbow after rain", "lightning storm",
  "fog morning in the mountains", "snowy mountains of Kurdistan", "spring flowers in the north", "autumn leaves", "palm grove in Basra",
  "wheat field", "rice field", "sunflower field", "orchard with pomegranates", "orange grove", "forest stream", "cave with stalactites",
  "volcano", "glacier", "tropical beach", "rocky coast with waves", "coral reef", "lake reflection", "river rapids", "waterfall pool",
  "sand dunes at noon", "salt flats", "canyon", "green valley with sheep", "city park in spring", "botanical garden", "roof garden",
  "city skyline at night", "foggy city street", "rainy city at night with neon", "snow in a city", "heatwave city at noon",
];

module.exports = {
  countries: { domain: "place", prefix: "place.world", guide: PLACE_GUIDE, topics: countries },
  iraq: { domain: "place", prefix: "place.iq2", guide: PLACE_GUIDE + " For Iraqi places be precise and local: real streets, buildings, materials, signage in Arabic or Kurdish, people and activity.", topics: iraq },
  landmarks: { domain: "place", prefix: "place.landmark", guide: "For a landmark: its exact shape, materials, colours and proportions, the setting around it, the light at different times, the people and sounds there.", topics: landmarks },
  items: { domain: "item", prefix: "item.gen", guide: "For an item: its exact design so it looks manufactured and correct (shape, parts in the right places, materials, logos and labels where they really are, scale to a person), how it is used and moves, and the sounds it makes.", topics: items },
  actions: { domain: "action", prefix: "action.gen", guide: "For an action or event: the body mechanics step by step, the faces and reactions of everyone involved, the objects and their physics, the sounds in sync, and the place and atmosphere.", topics: actions },
  human: { domain: "human", prefix: "human.gen", guide: "For a human expression, gesture or type of person: exactly what the face, eyes, mouth, hands and body do (or look like), timing, the matching non-verbal sounds and voice, kept respectful.", topics: human },
  sounds: { domain: "sound", prefix: "sound.gen", guide: "For a sound: what makes it (the visible action), how it really sounds (pitch, rhythm, loudness, length, echo), when it happens in sync with the picture, and what usually surrounds it.", topics: sounds },
  animals: { domain: "animal", prefix: "animal.gen", guide: "For an animal: correct anatomy and proportions, fur/feathers/scales texture, how it moves (gait, flight, swimming), behaviour and expressions, the sounds it makes, kept calm and non-violent.", topics: animals },
  nature: { domain: "nature", prefix: "nature.gen", guide: "For a nature scene: landforms, plants, water and sky, how light and weather behave, what moves (wind, water, animals) and the sounds.", topics: nature },
};

// expansion (tools/library-topics-more.js): more topics for the existing sets, and two new sets
{
  const more = require("./library-topics-more");
  for (const k of ["actions", "human", "sounds", "animals", "nature"]) module.exports[k].topics.push(...more[k]);
  module.exports.reality = { domain: "reality", prefix: "reality.gen", guide: "For a physics or material behaviour: exactly how it moves and reacts in the real world (forces, weight, timing, deformation, secondary motion), what the eye sees moment by moment, the matching sound, and the AI mistakes to avoid (floating, sliding, morphing, passing through objects).", topics: more.reality };
  module.exports.style = { domain: "style", prefix: "style.gen", guide: "For a camera move or look: the lens, movement, framing, lighting and colour in concrete terms, when it fits (ads, social, drama), and how it keeps people and motion realistic.", topics: more.style };
}
