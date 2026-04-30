# Tremola Whiteboard

Whiteboard Mini-App fuer Tremola.

## Benutzung

- `Notiz` waehlen und eine Notiz schreiben
- `Zeichnen` waehlen und auf der Flaeche zeichnen
- `Auswahl` waehlen und einen Rahmen um Objekte ziehen
- Ausgewaehlte Objekte koennen bearbeitet oder geloescht werden

## Lokal starten

`index.html` im Browser öffnen.

oder mit Py3 server:

```bash
python3 -m http.server 8080
```

danach über `http://localhost:8080` öffnen

## next steps um mit Tremola zu integrieren

- als Mini-App in Tremola webview laden
- window.tremolaWhiteboardStore in Tremola implementieren
- appendEvent schreibt Events (mit tinySSB)
- loadEvents liest eigene und BLE synchronisation events
- mit android testen

späterer anschluss an den  Event-Store und tinySSB/BLE
