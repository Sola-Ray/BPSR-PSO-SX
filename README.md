# BPSR-PSO

**Forked from:** https://github.com/dmlgzs/StarResonanceDamageCounter

Blue Protocol: Star Resonance - Per Second Overlay
Provides a useful GUI to track DPS / HPS for nearby players

## About the Project

This is a standalone application and does not interface with BPSR or modify any of its files. It analyzes packet while in transit. 

## Getting Started

These instructions will get you a copy of the project up and running on your local machine for development and testing purposes.

### Prerequisites

You'll need to have the following software installed:

* **Node.js**: <https://nodejs.org/>
* **npm**: Comes bundled with Node.js.
* **Npcap**: The installer is located in the `/resources` folder of this repository.

### Installation

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/Chase-Simmons/BPSR-PSO.git
    ```

2.  **Navigate into the project directory:**
    ```bash
    cd BPSR-PSO
    ```

3.  **Install Npcap:**
    * Navigate to the `resources` folder: `cd resources`
    * Run the Npcap installer. Be sure to select the option to **"Install Npcap in WinPcap API-compatible Mode"** during installation.
    * After installation, return to the project root: `cd ..`

4.  **Install Node.js dependencies:**
    ```bash
    npm install
    ```

## Running the Application

To start the application, run the following command from the project root:

```bash
npm start