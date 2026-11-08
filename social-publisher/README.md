# Social Publisher

Beş turizm sitesi için İngilizce içerik üreten, Canva marka şablonundan
görsel hazırlayan ve desteklenen sosyal ağlarda günlük paylaşım yapan açık
kaynak Cloud Run servisi.

## Desteklenen platformlar

- Facebook Pages
- Instagram Business
- Threads
- Pinterest
- Reddit
- Blogger
- Tumblr

Quora'nın genel paylaşım API'si olmadığı için kapsam dışındadır. Medium'un yeni
entegrasyon erişimi sınırlı, X API erişimi ise plana bağlı olduğundan ilk
sürümde yer almaz.

## Akış

1. Cloud Scheduler her gün saat 10:00'da `/v1/generate-daily` çağrısını yapar.
2. Servis her sitenin sitemap'inden o güne özel bir sayfa seçer.
3. Vertex AI, yalnızca sayfadaki gerçekleri kullanarak özgün İngilizce başlık,
   80-180 kelimelik metin ve 5-8 hashtag üretir.
4. Sayfanın görseli Canva'ya yüklenir; ilgili marka şablonundaki `headline`,
   `photo` ve `website` alanları doldurulur ve PNG dışa aktarılır.
5. Her etkin sosyal hesap için Firestore'a ayrı bir yayın işi yazılır.
6. Beş dakikalık dispatcher işleri platform API'lerine gönderir.

Ağ bağlantısı paylaşım sırasında belirsiz biçimde kesilirse iş otomatik tekrar
edilmez; mükerrer paylaşımı önlemek için `needs_review` durumuna alınır. Açık
429/5xx cevapları üstel gecikmeyle tekrar denenir.

## Siteler

`config/sites.json` içinde tanımlıdır:

- `ephesusancientcity.com`
- `creaostravel.com/en/`
- `turkiye-tour.com/en/`
- `biblicaltours-turkey.com`
- `ephesuscity-tours.com`

Her site için Canva şablonu hazırlandıktan sonra `canvaTemplateId` alanını
doldurun. Şablonlarda şu autofill alanları bulunmalıdır:

| Alan | Tip |
| --- | --- |
| `headline` | text |
| `photo` | image |
| `website` | text |

Canva otomasyonu Connect API, OAuth 2.0, marka şablonu okuma/yazma, asset
yükleme ve export izinleri gerektirir. Ayrıntılar:
<https://www.canva.com/developers/>

## Yerel geliştirme

Gereksinimler: Node.js 22+, bir Google Cloud projesi ve Application Default
Credentials.

```bash
npm ci
export GOOGLE_CLOUD_PROJECT="your-project-id"
npm run dev
```

Kontroller:

```bash
npm test
npm run typecheck
npm run build
```

## Google Cloud dağıtımı

```bash
gcloud auth application-default login
export PROJECT_ID="your-project-id"
chmod +x scripts/deploy-gcp.sh
./scripts/deploy-gcp.sh
```

Varsayılan bölge `europe-west1`, Firestore konumu `eur3` olarak ayarlanır.
Gerekirse `REGION` ve `FIRESTORE_LOCATION` değişkenleriyle değiştirilebilir.
Servis herkese açık değildir; Cloud Scheduler OIDC ile çağırır.

Firestore birleşik indekslerini bir kez oluşturun:

```bash
gcloud firestore indexes composite create \
  --collection-group=publicationJobs \
  --query-scope=collection \
  --field-config=field-path=status,order=ascending \
  --field-config=field-path=scheduledAt,order=ascending

gcloud firestore indexes composite create \
  --collection-group=publicationJobs \
  --query-scope=collection \
  --field-config=field-path=status,order=ascending \
  --field-config=field-path=leaseUntil,order=ascending

gcloud firestore indexes composite create \
  --collection-group=socialAccounts \
  --query-scope=collection \
  --field-config=field-path=siteId,order=ascending \
  --field-config=field-path=enabled,order=ascending
```

## Secret yapısı

Her sosyal hesap için ayrı bir Secret Manager secret'ı kullanılır. Secret
değeri JSON'dur:

```json
{
  "accessToken": "TOKEN"
}
```

Süresi dolan OAuth tokenlarını otomatik yenilemek için:

```json
{
  "accessToken": "TOKEN",
  "expiresAt": "2026-11-09T12:00:00Z",
  "refresh": {
    "tokenUrl": "PROVIDER_TOKEN_ENDPOINT",
    "clientId": "CLIENT_ID",
    "clientSecret": "CLIENT_SECRET",
    "refreshToken": "REFRESH_TOKEN",
    "authStyle": "basic",
    "extra": {}
  }
}
```

Servis yeni tokenı Secret Manager'a yeni sürüm olarak yazar. Secret değerlerini
Git'e eklemeyin veya sohbet içinde paylaşmayın.

Canva OAuth verisini varsayılan olarak `canva-oauth` adlı secret'a kaydedin.
Farklı ad için Cloud Run'a `CANVA_SECRET_ID` ortam değişkeni verin.

### Canva'yı ilk kez bağlama

Canva Developer Portal'da REST API izinlerini açın:

- `asset`: Read + Write
- `brandtemplate:content`: Read
- `brandtemplate:meta`: Read
- `design:content`: Read + Write
- `design:meta`: Read

Google Cloud Console → Secret Manager içinde `canva-oauth-client` adında bir
secret oluşturun. Değeri şu JSON biçiminde olmalıdır:

```json
{
  "clientSecret": "CANVA_CLIENT_SECRET",
  "setupKey": "AT_LEAST_32_RANDOM_CHARACTERS"
}
```

`setupKey` değerini `openssl rand -base64 48` ile üretin. Bu değer ve Client
Secret sohbet, Git veya uygulama loglarına yazılmamalıdır.

Dağıtım sırasında Client ID'yi verin:

```bash
export PROJECT_ID="your-project-id"
export CANVA_CLIENT_ID="your-canva-client-id"
./scripts/deploy-gcp.sh
```

Betik sonunda `Canva redirect URL` değerini yazdırır. Canva Developer Portal →
Outside Canva → Redirect URLs alanındaki geçici localhost adresini bu gerçek
HTTPS adresiyle değiştirin.

Bir kez yetkilendirme bağlantısı üretin:

```bash
read -s CANVA_SETUP_KEY
curl -H "Authorization: Bearer ${CANVA_SETUP_KEY}" \
  "https://YOUR-OAUTH-SERVICE/oauth/canva/start"
unset CANVA_SETUP_KEY
```

Dönen `authorizationUrl` adresini tarayıcıda açıp Canva hesabını onaylayın.
Callback kısa ömürlü PKCE state kullanır ve dönen access/refresh tokenlarını
`canva-oauth` secret'ına yazar. Canva refresh tokenları tek kullanımlık olduğu
için servis her yenilemede yeni tokenı Secret Manager'a yeni sürüm olarak
kaydeder.

## Sosyal hesap ekleme

Önce ilgili OAuth secret'ını Secret Manager'da oluşturun. Ardından hesabı
Firestore'a ekleyin:

```bash
export GOOGLE_CLOUD_PROJECT="your-project-id"
npm run account:add -- \
  --id ephesus-instagram \
  --site ephesus-ancient-city \
  --platform instagram \
  --destination INSTAGRAM_BUSINESS_ACCOUNT_ID \
  --secret ephesus-instagram-oauth
```

`destination` değerleri:

- Facebook: Page ID
- Instagram: Instagram Business Account ID
- Threads: Threads User ID
- Pinterest: Board ID
- Reddit: subreddit adı
- Blogger: Blog ID
- Tumblr: blog identifier

## Elle içerik kuyruğa alma

Cloud Run kimlik tokenıyla:

```bash
curl -X POST "$SERVICE_URL/v1/publications" \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  -H "Content-Type: application/json" \
  -d '{
    "siteId": "ephesus-ancient-city",
    "language": "en",
    "accountIds": ["ephesus-instagram"],
    "content": {
      "title": "Walk through ancient Ephesus",
      "text": "Discover the details that make Ephesus unforgettable.",
      "link": "https://ephesusancientcity.com/",
      "imageUrl": "https://example.com/image.jpg",
      "hashtags": ["Ephesus", "TurkeyTravel", "AncientHistory"]
    }
  }'
```

## Güvenlik

- Kullanıcı adı ve parola tutulmaz; yalnızca OAuth tokenları kullanılır.
- Cloud Run IAM korumalıdır.
- Secret değerleri loglanmaz ve istek loglarında Authorization başlığı
  maskelenir.
- Bir sitenin hesabı başka bir site adına kuyruğa alınamaz.
- Platform API yanıt gövdeleri Firestore'a yazılmaz.

## Lisans

MIT
