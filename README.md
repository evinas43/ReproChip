# ReproChip 0.3

App de escritorio (Windows, macOS y Linux) para **leer centralitas por OBD** y **analizar archivos .bin** con un asistente de IA (Claude). Pensada para empezar con un Citroën C4 1.6 HDi 92 cv con centralita Bosch.

> **No escribe en la centralita.** ReproChip lee por OBD y trabaja con archivos: los analiza y te deja **editar mapas en una copia**, pero nunca toca el original ni corrige el checksum. Para leer o escribir el flash del coche hace falta una herramienta profesional (KESS, KTAG, Autotuner…).

## Qué hace

| Pestaña | Qué hace |
|---|---|
| **Vehículos** | Biblioteca de fichas de coches y centralitas. **Añadir con IA**: describes el coche (o usas la lectura del coche o el archivo abierto) y Claude prepara la ficha: motor, centralita, orden de bytes, protocolo, mapas típicos con unidad y factor, averías propias de la marca y PIDs recomendados. La revisas y la guardas. También a mano, importar y exportar en JSON. |
| **Conexión** | ELM327 u OBDLink por USB, Bluetooth clásico (puerto serie) o WiFi. Detecta la velocidad del puerto y el protocolo. Incluye un **simulador** de C4 1.6 HDi para probar sin coche. |
| **Identificación** | VIN, **Calibration ID** y **CVN** (modo 09): identifican el software exacto de la centralita. Lectura UDS 0x22 experimental (referencia, hardware y software). |
| **Averías** | Códigos memorizados, pendientes y permanentes con descripción en español, estado del testigo y borrado (con confirmación). |
| **Datos en vivo** | RPM, MAP (turbo), MAF, presión de rail, pedal, EGR, temperaturas, tensión… con mini gráficas, grabación y exportación a CSV (formato Excel en español). |
| **Logs** | Graba un tirón o un recorrido y lo revisa después: todas las señales en la misma línea de tiempo (zoom y cursor), **detección automática de tirones a fondo** con sobrepresión, rail, MAF, par y temperaturas máximas, y **comparación de dos tirones por régimen** (antes/después de una reprogramación) con el tiempo de 2000 a 4000 rpm. **Dinamómetro virtual**: estima potencia (cv) y par (Nm) de cada tirón a partir de la aceleración, el peso y la aerodinámica del coche, y superpone dos curvas (por ejemplo serie y Stage 1). Pide varias PIDs por petición si la centralita lo admite. Guarda y abre CSV, y se lo pasa al asistente. |
| **Archivo .bin** | Detecta la familia (EDC16/EDC17…), números Bosch y PSA, **busca mapas 2D**, los muestra como tabla de colores, **compara original y modificado** (celda a celda y en %), tiene visor hexadecimal y un **editor de mapas** que guarda en una copia nueva. |
| **Asistente IA** | Pregunta a Claude con el contexto que elijas: vehículo, identificación, averías, datos en vivo y archivo o mapa seleccionado. |
| **Terminal** | Comandos AT y peticiones OBD/UDS en hexadecimal. Bloquea todo lo que escribe o programa (0x2E, 0x31, 0x34–0x37, 0x27, sesión de programación…). |

## Puesta en marcha

Necesitas **Node.js 20 o superior** (https://nodejs.org).

```bash
cd reprochip
npm install        # descarga Electron (unos 100 MB la primera vez)
npm start          # abre la app
npm test           # 38 pruebas: driver, OBD, simulador, mapas, fichas y editor
```

Para crear un instalador (`.exe`, `.dmg` o `.AppImage`):

```bash
npm run dist       # el resultado queda en la carpeta dist/
```

**Pruébala sin coche:** Conexión → **Simulador** → Conectar. Luego, en «Archivo .bin», abre `samples/demo_edc17_ori.bin` y compáralo con `samples/demo_edc17_mod.bin`. Los dos son **sintéticos** (no salen de ninguna centralita real) y sirven para ver el buscador de mapas y el comparador.

## Editar mapas

1. En «Archivo .bin», abre la lectura original y elige un mapa.
2. Ponle el factor y la unidad (o elige su nombre de la ficha: se rellenan solos) para trabajar en valores reales.
3. Pulsa **Editar mapa**. Se crea una copia de trabajo (`…_mod.bin`); si ya tenías un modificado abierto, se edita ese.
4. Selecciona celdas: clic y arrastrar, `Mayús`+clic para ampliar, `Ctrl`+clic para sueltas, clic en un eje para la fila o columna entera, clic en la esquina o `Ctrl+A` para todo.
5. Cambia los valores:
   - Botones **−5 %, −1 %, +1 %, +5 %**, o las teclas `+` y `−` (1 %).
   - **Sumar %**, **Sumar valor** o **Fijar valor** con el número que escribas.
   - **Doble clic** en una celda para escribir su valor.
   - **Interpolar**: rellena en línea recta entre los extremos de la selección.
   - **Suavizar**: media con las celdas vecinas, para quitar escalones.
   - **Deshacer / Rehacer** (`Ctrl+Z` / `Ctrl+Y`), sin límite práctico.
6. Mira el resultado en **Diferencia %**: la cabecera del mapa muestra cuántas celdas has cambiado y el % máximo. «Revisar con IA» le pide al asistente que compruebe si los cambios son coherentes.
7. **Guardar copia .bin…** guarda un archivo nuevo. El original no se modifica nunca.

> **Checksum:** ReproChip no lo corrige. Antes de escribir un archivo editado en un coche, corrígelo con tu herramienta (KESS, KTAG… lo hacen al escribir en muchas centralitas, compruébalo para la tuya) y guarda siempre la lectura original como copia de seguridad.

## Fichas de vehículos y centralitas

La **ficha activa** (la que marcas con «Usar este vehículo») se aplica en toda la app:

- **Conexión:** pone el protocolo OBD de la ficha.
- **Averías:** si la base de la app no conoce un código (los P1xxx de PSA, por ejemplo), usa la descripción de la ficha.
- **Datos en vivo:** selecciona los PIDs recomendados (botón «PIDs de la ficha»).
- **Archivo .bin:** si el archivo no dice su familia, usa el orden de bytes de la ficha.
- **Etiquetas de mapas:** al seleccionar un mapa puedes ponerle nombre, unidad y factor y guardarlo en la ficha. Se guardan por software (clave `SW 1037…` o familia + tamaño). Al abrir otra lectura del mismo software, los mapas salen ya con nombre; si un mapa igual está etiquetado en otro software, aparece como sugerencia «¿nombre?».
- **Asistente:** recibe la ficha como contexto.

«Completar con IA» rellena lo que falte en una ficha sin tocar lo que ya has escrito; si la IA cree que algo está mal, lo pone en la lista de cosas a comprobar. Las fichas generadas con IA llevan la etiqueta **IA**, su fiabilidad y lo que hay que confirmar en el coche: revísalas antes de fiarte.

La biblioteca se guarda en `profiles.json`, en la carpeta de datos de la app. Con «Exportar biblioteca» puedes pasarla a otro ordenador o compartirla con alguien.

## Asistente IA

1. Crea una clave de API en https://console.anthropic.com (la API se paga por uso, aparte de la suscripción de Claude).
2. En **Ajustes**, pega la clave y pulsa Guardar. Se guarda solo en tu ordenador, cifrada si el sistema lo permite, y únicamente la usa el proceso principal de la app: la interfaz nunca la ve.
3. Modelo por defecto: `claude-sonnet-5-5` (puedes cambiarlo en Ajustes).

Cada pregunta envía a la API el contexto marcado en la pestaña del asistente (incluido el VIN si has leído la identificación). Desmarca lo que no quieras enviar.

## Adaptador recomendado

Guía de compra con enlaces y precios: [docs/adaptador-obd2.html](docs/adaptador-obd2.html) (ábrela con el navegador; también guardada en https://claude.ai/artifact/Gm4UJ9hpiQ4xKUnfH3sBcj).

- **Mejor opción:** OBDLink SX (USB) o EX. Son rápidos y estables con respuestas largas.
- **ELM327 USB de calidad** (chip FTDI o CH340): sirve. En Windows puede hacer falta instalar el driver del chip.
- **Bluetooth clásico:** empareja primero en el sistema; aparece como puerto COM (Windows) o `/dev/cu.*` (macOS).
- **WiFi:** conecta el ordenador a la red del adaptador (normalmente 192.168.0.10, puerto 35000).
- **Bluetooth LE (BLE)** todavía no está soportado.

## Sobre tu C4 1.6 HDi 92 cv

- Lo más probable es una **Bosch EDC17C10** (C4 II, desde 2010) o una **EDC16C34** en motores anteriores. Lo confirmas en la etiqueta de la propia centralita o con el Calibration ID que lee la app.
- El OBD estándar (EOBD) funciona por CAN a 500 kbaud en la toma OBD. Lo propio de PSA (identificadores DiagBox, parámetros avanzados) no siempre responde a las peticiones estándar.
- En el archivo, EDC17 usa **little-endian** y EDC16 **big-endian**; la app lo detecta sola, pero puedes forzarlo.

## Cómo está hecha

```
reprochip/
├── main.js             Proceso principal: ventana, puertos serie, puente WiFi, ajustes, API de Claude
├── preload.js          Puente seguro entre interfaz y proceso principal
├── src/
│   ├── index.html, styles.css, app.js     Interfaz
│   └── lib/
│       ├── elm327.js       Driver ELM327/STN: cola de comandos, tramas CAN (ISO-TP) y K-Line
│       ├── datalog.js      Logs: CSV, detección de tirones, estadísticas, curvas por régimen
│       ├── obd.js          Modos 01/03/04/07/09/0A, UDS 0x22, averías en español, bloqueo de solo lectura
│       ├── transport.js    Web Serial (USB/BT), TCP (WiFi) y simulador
│       ├── simulator.js    ELM327 + ECU EDC17C10 simulados con tramas CAN reales
│       ├── binanalyzer.js  Identificación, buscador de mapas, comparador
│       ├── profiles.js     Fichas de vehículos: validación, prompt de la IA, etiquetas de mapas
│       ├── mapedit.js      Editor de mapas: operaciones, límites de 16 bit, deshacer/rehacer
│       └── ai.js           Prompt del asistente y Markdown seguro
├── samples/            Archivos .bin de demostración (sintéticos)
├── scripts/make-samples.js
└── test/run-tests.js
```

Seguridad de Electron: `contextIsolation` activado, sin Node en la interfaz, `sandbox` activado y CSP estricta.

## Límites de esta versión

- **No lee ni escribe el flash.** Leer el .bin por OBD exige acceso de seguridad y protocolos de arranque propios de Bosch: para eso, herramienta profesional.
- **No corrige checksums** ni edita ejes de los mapas ni mapas de 8 bit (por ahora solo los datos de mapas 2D de 16 bit).
- El **buscador de mapas es heurístico**: encuentra mapas 2D de 16 bit con cabecera de tamaño y ejes crecientes (estilo Bosch). Puede dejarse mapas (ejes compartidos, mapas de 8 bit) y dar algún falso positivo. No pone nombres a los mapas: el asistente sugiere qué puede ser cada uno.
- La lectura UDS es experimental: muchas centralitas PSA usan identificadores propios.
- El asistente no da instrucciones para anular sistemas anticontaminación (FAP, EGR, AdBlue) ni el inmovilizador.

## Siguientes pasos posibles

1. Identificadores propios de PSA (lectura de referencias tipo DiagBox).
2. Vista 3D de mapas, edición de ejes y detección de mapas con ejes compartidos.
3. Soporte de adaptadores Bluetooth LE.
4. Exportar un informe de diagnóstico en PDF.
5. Biblioteca de fichas compartida en la nube entre varios equipos.
