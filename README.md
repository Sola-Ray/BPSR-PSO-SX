# BPSR-PSO-SX (Sola Extended)

> A modified and extended version of BPSR-PSO built for Blue Protocol — the “SX” stands for *Sola Extended*.

## Table of Contents
- [About](#about)  
- [Origins & Acknowledgements](#origins--acknowledgements)  
- [Features](#features)  
- [Getting Started](#getting-started)  
  - [Prerequisites](#prerequisites)  
  - [Installation](#installation)  
  - [Running the Application](#running-the-application)  
- [Usage](#usage)  
- [Contributing](#contributing)  
- [License](#license)  

## About  
BPSR-PSO-SX is an overlay / monitoring tool for Blue Protocol that tracks player performance metrics such as DPS/HPS on a per-second basis and provides extended functionality over the original toolset.

## Origins & Acknowledgements  
This project is based on and builds upon the work of two prior projects:  
- [StarResonanceDamageCounter](https://github.com/dmlgzs/StarResonanceDamageCounter) — originally designed for Blue Protocol, providing DPS/HPS tracking.  
- [BPSR-PSO](https://github.com/Chase-Simmons/BPSR-PSO.git) by Chase Simmons — a forkable version of the above, providing the base architecture for this project.

Thanks to both authors for laying the groundwork for this extended variant.

## Features  
- Real-time DPS (damage per second) and HPS (healing per second) metrics.  
- Overlay view that updates dynamically for nearby players.  
- Extended tracking, logging, and customization options (*Sola Extended* features).  
- Packet interception and analysis (no modification of the game or BPSR files).

## Getting Started  

### Prerequisites  
You will need the following installed on your machine:  
- Node.js (and npm)  
- Npcap (for packet capture) — see the `resources` folder for installer.

### Installation  
1. Clone the repository:  
   ```bash
   git clone https://github.com/Sola-Ray/BPSR-PSO-SX.git
   ```
2. Change into the project directory:  
   ```bash
   cd BPSR-PSO-SX
   ```
3. Install Npcap:  
   ```bash
   cd resources
   # Run the installer and make sure to enable “Install Npcap in WinPcap API-compatible Mode”
   cd ..
   ```
4. Install Node.js dependencies:  
   ```bash
   npm install
   ```

### Running the Application  
```bash
npm start
```

The overlay should launch and begin monitoring packets from the game client.

## Usage  
- Start the game and launch the overlay.  
- Ensure Npcap is installed and has permissions to capture.  
- Use the overlay to monitor DPS/HPS and other tracked metrics in real time.  
- *(You may include screenshots, configuration instructions, hotkeys, customizations, etc.)*

## Contributing  
We welcome contributions! If you’d like to help improve or extend the project:  
- Fork this repository.  
- Create a new feature branch (`git checkout -b feature/YourFeature`).  
- Commit your changes and submit a pull request.  
- Be sure to document any new configuration options or breaking changes.

Please follow standard Node.js/JavaScript style guidelines and add tests where applicable.

## License  
This project is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0) — see the [LICENSE.txt](LICENSE.txt) file for details.

---

Thank you for using **BPSR-PSO-SX** — happy raiding and tracking!
