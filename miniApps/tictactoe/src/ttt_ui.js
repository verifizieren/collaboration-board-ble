"use strict";

var TTTScenario = null;

function setTTTScenario(s) {
    console.log("setTTTScenario", s);

    console.log("scenarioDisplay", scenarioDisplay);

    var lst = scenarioDisplay[s];
    console.log("scenarioDisplay", lst);
    load_board_list();

    display_or_not.forEach(function (d) {
        console.log(d);
        let element = document.getElementById(d);
        if (element) {
            if (lst.indexOf(d) < 0) {
                element.style.display = 'none';
            } else {
                element.style.display = null;
            }
        } else {
            console.warn(`Element with ID '${d}' not found.`);
        }
    });

    TTTScenario = s;

    if (s == 'tictactoe-list') {
        document.getElementById("tremolaTitle").style.display = 'none';
        var c = document.getElementById("conversationTitle");
        c.style.display = null;
        c.innerHTML = "<font size=+1><strong>Tic Tac Toe</strong><br>Pick or create a new game</font>";
        ttt_load_list();
    }
    if (s == 'tictactoe-board') {
        document.getElementById("tremolaTitle").style.display = 'none';
        var c = document.getElementById("conversationTitle");
        c.style.display = null;
        let fed = tremola.tictactoe.active[tremola.tictactoe.current].peer
        c.innerHTML = `<font size=+1><strong>TTT with ${fid2display(fed)}</strong></font>`;
    }
}


function load_board_list() {
}