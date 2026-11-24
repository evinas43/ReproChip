# Adaptador OBD2 para ReproChip (Citroën C4 1.6 HDi)

Es un único aparato: un extremo va a la toma OBD del coche y el otro a un USB del ordenador. No hace falta ningún cable más.

**Funciona con ReproChip:** la app se conecta por el puerto COM que crea Windows al enchufar un adaptador USB tipo ELM327 (chip FTDI o CH340). En ReproChip: **Conexión → USB / Bluetooth → Conectar** y eliges el puerto COM.

Toma del coche: OBD2 de 16 pines · ISO 15765-4 CAN a 500 kbaud (pines 6 y 14) · bajo el salpicadero, lado del conductor.

## Qué comprar

| Opción | Precio aprox. | Dónde | Por qué |
|---|---|---|---|
| **OBDLink EX (USB)** — la más fiable | 60–85 € | Amazon / fabricante | Chip STN2230 + USB FTDI. Pide varios parámetros a la vez: más muestras por segundo para logs y dinamómetro. Sustituye al OBDLink SX (descatalogado). |
| **Vgate vLinker FS USB** — equilibrio | 35–60 $ | AliExpress | Marca conocida, tienda oficial, 2 años de garantía. Algunos anuncios indican FTDI FT232RL. Elegir la versión **USB** (también existe en Bluetooth). |
| **ELM327 USB clónico** — el más barato | 10–35 € | AliExpress | Buscar «PIC18F25K80» + «FT232RL». Casi todos son copias: comprar con devolución. Puede que la app tenga que pedir los parámetros de uno en uno. |

### Enlaces

OBDLink EX
- Amazon.es (búsqueda): https://www.amazon.es/s?k=OBDLink+EX
- Amazon (ficha, ASIN B081VQVD3F): https://amazon.com/-/es/OBDLink-Adaptador-OBD-EX-FORScan/dp/B081VQVD3F
- Fabricante: https://www.obdlink.com/products/obdlink-ex/

Vgate vLinker FS USB
- AliExpress (anuncio): https://www.aliexpress.us/item/3256802930481942.html
- AliExpress (otro vendedor): https://www.aliexpress.us/item/3256812154703705.html
- AliExpress España (búsqueda): https://es.aliexpress.com/w/wholesale-vgate-vlinker-fs-usb.html

ELM327 USB clónico
- AliExpress «ELM327 USB PIC18F25K80»: https://es.aliexpress.com/w/wholesale-pic18f25k80-obd2-elm327-usb.html
- AliExpress «ELM327 FT232RL»: https://es.aliexpress.com/w/wholesale-ft232rl-elm327.html

Términos para buscar: `OBDLink EX` · `Vgate vLinker FS USB` · `ELM327 USB PIC18F25K80 FT232RL`

Precios orientativos tomados de los anuncios el 23 de noviembre de 2026; cambian a menudo.

## Qué mirar en el anuncio

- ✓ Conexión **USB** (Bluetooth clásico y WiFi también funcionan, pero en el coche el USB es lo más estable).
- ✓ Chip USB **FTDI FT232RL** (o CH340).
- ✓ Compatible con **ELM327** y protocolos **CAN (ISO 15765-4)**.
- ✓ Si trae interruptor HS/MS-CAN (para Ford), dejarlo en **HS** para el Citroën.
- ✕ «Bluetooth 4.0», «BLE» o «compatible con iPhone»: ReproChip todavía no los soporta.
- ✕ «v2.1» o anuncios que no dicen qué chip llevan.

## Cuando llegue

1. Enchufarlo al portátil antes de abrir ReproChip (Windows instala el driver solo).
2. Conectarlo a la toma OBD, poner el contacto y arrancar con el coche parado.
3. ReproChip: Conexión → USB / Bluetooth → Conectar, elegir el puerto COM, protocolo «Automático».
4. Primera prueba al ralentí: en Logs, grabar 20–30 s y ver qué parámetros salen y cuántas muestras por segundo.

Fuentes: obdlink.com (OBDLink EX), manuals.plus (SX descatalogado), obdadvisor.com (reseña EX y guía ELM327), skanyx.com (precio en euros), anuncios de AliExpress citados arriba.
